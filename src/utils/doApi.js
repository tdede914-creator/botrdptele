const axios = require('axios');

const DO_API = 'https://api.digitalocean.com/v2';
const LINODE_API = 'https://api.linode.com/v4';
const AWS_EC2_HOST = (region) => `ec2.${region}.amazonaws.com`;
const AWS_STS_HOST = (region) => region === 'us-east-1' ? 'sts.amazonaws.com' : `sts.${region}.amazonaws.com`;
const AWS_SSM_HOST = (region) => `ssm.${region}.amazonaws.com`;
function awsHost(service, region) {
  if (service === 'sts') return AWS_STS_HOST(region);
  if (service === 'ssm') return AWS_SSM_HOST(region);
  return AWS_EC2_HOST(region);
}
function awsApiVersion(service) {
  if (service === 'sts') return '2011-06-15';
  if (service === 'ssm') return '2014-11-06';
  return '2016-11-15';
}
const awsInstanceRegionCache = new Map();

function isAwsToken(token) {
  return String(token || '').startsWith('aws:');
}

function parseAwsToken(token) {
  const raw = String(token || '').trim();
  const body = raw.startsWith('aws:') ? raw.slice(4) : raw;
  try {
    const obj = JSON.parse(Buffer.from(body, 'base64').toString('utf8'));
    return {
      accessKeyId: obj.accessKeyId || obj.access_key_id || obj.AWS_ACCESS_KEY_ID,
      secretAccessKey: obj.secretAccessKey || obj.secret_access_key || obj.AWS_SECRET_ACCESS_KEY,
      region: obj.region || obj.AWS_REGION || 'us-east-1'
    };
  } catch (_) {
    const parts = body.split('|').map(x => x.trim());
    return { accessKeyId: parts[0], secretAccessKey: parts[1], region: parts[2] || 'us-east-1' };
  }
}

function makeAwsToken(accessKeyId, secretAccessKey, region = 'us-east-1') {
  const obj = { accessKeyId: String(accessKeyId || '').trim(), secretAccessKey: String(secretAccessKey || '').trim(), region: String(region || 'us-east-1').trim() };
  return `aws:${Buffer.from(JSON.stringify(obj), 'utf8').toString('base64')}`;
}


function isLinodeToken(token) {
  return String(token || '').startsWith('linode:');
}

function cleanToken(token) {
  const t = String(token || '').trim();
  if (isLinodeToken(t)) return t.replace(/^linode:/, '');
  return t;
}


function sanitizeLinodeLabel(name) {
  let label = String(name || 'vps')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/_+/g, '_')
    .replace(/^[^a-zA-Z0-9]+/, '')
    .replace(/[^a-zA-Z0-9]+$/, '');

  if (!label) label = `vps-${Date.now()}`;
  if (label.length > 64) {
    label = label.slice(0, 64).replace(/[^a-zA-Z0-9]+$/, '');
  }
  if (!/^[a-zA-Z0-9]/.test(label)) label = `vps-${label}`;
  if (!/[a-zA-Z0-9]$/.test(label)) label = `${label}1`;
  return label.slice(0, 64);
}

function providerName(token) {
  if (isAwsToken(token)) return 'AWS';
  return isLinodeToken(token) ? 'Linode' : 'DigitalOcean';
}

function headers(token) {
  return {
    Authorization: `Bearer ${cleanToken(token)}`,
    'Content-Type': 'application/json'
  };
}

async function linodeGetTypes(token) {
  const all = [];
  let page = 1;
  while (true) {
    const r = await axios.get(`${LINODE_API}/linode/types?page=${page}&page_size=500`, { headers: headers(token), timeout: 30000 });
    const rows = Array.isArray(r.data?.data) ? r.data.data : [];
    all.push(...rows.map(t => ({
      slug: t.id,
      id: t.id,
      memory: Number(t.memory || 0),
      vcpus: Number(t.vcpus || 0),
      disk: Number(t.disk || 0),
      transfer: Number(t.transfer || 0),
      price_monthly: Number(t.price?.monthly || 0),
      available: true,
      regions: [],
      label: t.label || t.id,
      provider: 'linode'
    })));
    const pages = Number(r.data?.pages || page);
    if (page < pages) { page += 1; continue; }
    break;
  }
  return all.sort((a, b) => (a.vcpus - b.vcpus) || (a.memory - b.memory) || a.slug.localeCompare(b.slug));
}

async function linodeGetRegions(token) {
  const all = [];
  let page = 1;
  while (true) {
    const r = await axios.get(`${LINODE_API}/regions?page=${page}&page_size=500`, { headers: headers(token), timeout: 30000 });
    const rows = Array.isArray(r.data?.data) ? r.data.data : [];
    all.push(...rows.map(x => ({
      slug: x.id,
      id: x.id,
      name: x.label || x.id,
      available: true,
      country: x.country,
      capabilities: x.capabilities || [],
      provider: 'linode'
    })));
    const pages = Number(r.data?.pages || page);
    if (page < pages) { page += 1; continue; }
    break;
  }
  return all;
}

async function linodeGetImages(token) {
  // Common Linux images for Linode. The API also accepts these IDs directly.
  return [
    { label: '🟠 Ubuntu 24.04 LTS', slug: 'linode/ubuntu24.04' },
    { label: '🟠 Ubuntu 22.04 LTS', slug: 'linode/ubuntu22.04' },
    { label: '🔵 Debian 12', slug: 'linode/debian12' },
    { label: '🔵 Debian 11', slug: 'linode/debian11' },
    { label: 'AlmaLinux 9', slug: 'linode/almalinux9' },
    { label: 'Rocky Linux 9', slug: 'linode/rocky9' }
  ];
}


function normalizeLinodeImage(image) {
  const x = String(image || '').trim();
  const map = {
    'ubuntu-22-04-x64': 'linode/ubuntu22.04',
    'ubuntu-24-04-x64': 'linode/ubuntu24.04',
    'debian-11-x64': 'linode/debian11',
    'debian-12-x64': 'linode/debian12'
  };
  if (map[x]) return map[x];
  if (x.startsWith('linode/')) return x;
  return 'linode/ubuntu22.04';
}

async function linodeCreateInstance(token, name, region, type, image, rootPass, userData) {
  try {
    const payload = {
      label: sanitizeLinodeLabel(name),
      region,
      type,
      image: normalizeLinodeImage(image),
      root_pass: rootPass,
      // Jangan injeksi SSH key dari profil/account. Bot butuh login root via password
      // untuk menjalankan installer RDP setelah VPS aktif.
      authorized_keys: [],
      authorized_users: [],
      booted: true
    };

    // Linode API menerima cloud-init lewat metadata.user_data dan wajib base64.
    // Tanpa ini, setting ssh_pwauth/PermitRootLogin dari bot tidak pernah dijalankan,
    // sehingga SSH terlihat hanya menerima key-auth dan bot gagal auth password.
    if (userData && String(userData).trim()) {
      payload.metadata = {
        user_data: Buffer.from(String(userData), 'utf8').toString('base64')
      };
    }

    const r = await axios.post(`${LINODE_API}/linode/instances`, payload, { headers: headers(token), timeout: 60000 });
    const inst = r.data || {};
    if (!inst.id) return { dropletId: null, error: 'Failed to create Linode instance' };
    return { dropletId: inst.id, error: null };
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    const msg = data?.errors?.map(e => e.reason || e.field).filter(Boolean).join('; ') || data?.message || err.message || 'Unknown error';
    return { dropletId: null, error: status ? `HTTP ${status}: ${msg}` : msg };
  }
}

async function linodeWaitPublicIp(token, id, attempts = 30, delayMs = 10000) {
  for (let i = 0; i < attempts; i++) {
    await new Promise(r => setTimeout(r, delayMs));
    const r = await axios.get(`${LINODE_API}/linode/instances/${id}`, { headers: headers(token), timeout: 30000 });
    const ipv4 = r.data?.ipv4 || [];
    const ip = Array.isArray(ipv4) ? ipv4.find(x => String(x).indexOf(':') === -1) : null;
    if (ip) return ip;
  }
  return null;
}


async function linodeSetDirectDisk(token, id) {
  if (!isLinodeToken(token)) return { ok: false, error: 'Token bukan Linode' };
  try {
    const cfg = await axios.get(`${LINODE_API}/linode/instances/${id}/configs?page=1&page_size=100`, { headers: headers(token), timeout: 30000 });
    const configs = Array.isArray(cfg.data?.data) ? cfg.data.data : [];
    if (!configs.length) return { ok: false, error: 'Config Linode tidak ditemukan' };
    const target = configs.find(c => c.booted) || configs[0];
    const configId = target.id;
    if (!configId) return { ok: false, error: 'Config ID Linode tidak ditemukan' };

    const payload = { kernel: 'linode/direct-disk' };
    const r = await axios.put(`${LINODE_API}/linode/instances/${id}/configs/${configId}`, payload, { headers: headers(token), timeout: 30000 });
    return { ok: r.status === 200, error: null, configId, previousKernel: target.kernel || null };
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    const msg = data?.errors?.map(e => e.reason || e.field).filter(Boolean).join('; ') || data?.message || err.message || 'Unknown error';
    return { ok: false, error: status ? `HTTP ${status}: ${msg}` : msg };
  }
}

async function linodePower(token, id, action) {
  try {
    const endpoint = action === 'on' ? 'boot' : 'shutdown';
    const r = await axios.post(`${LINODE_API}/linode/instances/${id}/${endpoint}`, {}, { headers: headers(token), timeout: 30000 });
    return { ok: r.status === 200 || r.status === 202, error: null };
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    const msg = data?.errors?.map(e => e.reason || e.field).filter(Boolean).join('; ') || data?.message || err.message || 'Unknown error';
    return { ok: false, error: status ? `HTTP ${status}: ${msg}` : msg };
  }
}

async function linodeDelete(token, id) {
  try {
    const r = await axios.delete(`${LINODE_API}/linode/instances/${id}`, { headers: headers(token), timeout: 30000 });
    return r.status === 200 || r.status === 204;
  } catch (_) {
    return false;
  }
}


function awsHash(x) { return cryptoRequire().createHash('sha256').update(x, 'utf8').digest('hex'); }
function awsHmac(key, data, enc) { return cryptoRequire().createHmac('sha256', key).update(data, 'utf8').digest(enc); }
function cryptoRequire() { return require('crypto'); }
function awsDateParts() {
  const d = new Date();
  const iso = d.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}
function awsSign({ token, service, region, host, payload }) {
  const { accessKeyId, secretAccessKey } = parseAwsToken(token);
  if (!accessKeyId || !secretAccessKey) throw new Error('AWS credentials tidak lengkap');
  const { amzDate, dateStamp } = awsDateParts();
  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const contentType = 'application/x-www-form-urlencoded; charset=utf-8';
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'content-type;host;x-amz-date';
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, awsHash(payload)].join('\n');
  const stringToSign = [algorithm, amzDate, credentialScope, awsHash(canonicalRequest)].join('\n');
  const kDate = awsHmac('AWS4' + secretAccessKey, dateStamp);
  const kRegion = awsHmac(kDate, region);
  const kService = awsHmac(kRegion, service);
  const kSigning = awsHmac(kService, 'aws4_request');
  const signature = awsHmac(kSigning, stringToSign, 'hex');
  return {
    'Content-Type': contentType,
    'X-Amz-Date': amzDate,
    Authorization: `${algorithm} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  };
}
async function awsQuery(token, service, action, params = {}, regionOverride = null) {
  const creds = parseAwsToken(token);
  const region = regionOverride || creds.region || 'us-east-1';
  const host = awsHost(service, region);
  const endpoint = `https://${host}/`;
  const body = new URLSearchParams({ Action: action, Version: awsApiVersion(service), ...params }).toString();
  const hdr = awsSign({ token, service, region, host, payload: body });
  const r = await axios.post(endpoint, body, { headers: hdr, timeout: 60000 });
  return r.data;
}
function xmlText(xml, tag) {
  const m = String(xml || '').match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1] : null;
}
function xmlAll(xml, tag) {
  return [...String(xml || '').matchAll(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'g'))].map(m => m[1]);
}
const AWS_REGIONS = [
  ['us-east-1','US East (N. Virginia)'], ['us-east-2','US East (Ohio)'], ['us-west-1','US West (N. California)'], ['us-west-2','US West (Oregon)'],
  ['ap-southeast-1','Asia Pacific (Singapore)'], ['ap-southeast-2','Asia Pacific (Sydney)'], ['ap-south-1','Asia Pacific (Mumbai)'], ['ap-northeast-1','Asia Pacific (Tokyo)'],
  ['eu-west-1','Europe (Ireland)'], ['eu-central-1','Europe (Frankfurt)']
];
const AWS_TYPES = [
  // Recommended AWS RDP-safe sizes. t2/m4 are preferred because they normally expose /dev/xvda, not NVMe.
  ['t2.nano',0.5,1,8,0.0058],
  ['t2.micro',1,1,8,0.0116],
  ['t2.small',2,1,8,0.023],
  ['t2.medium',4,2,8,0.0464],
  ['t2.large',8,2,16,0.0928],
  ['t2.xlarge',16,4,32,0.1856],
  ['t2.2xlarge',32,8,32,0.3712],

  ['m4.xlarge',16,4,40,0.20],
  ['m4.2xlarge',32,8,80,0.40],
  ['m4.4xlarge',64,16,160,0.80],
  ['m4.10xlarge',160,40,320,2.00],
  ['m4.16xlarge',256,64,640,3.20],

  // Also display common newer sizes; if used for RDP, awsCreateInstance normalizes them to t2/m4.
  ['t3.micro',1,1,8,0.0104],
  ['t3.small',2,1,8,0.0208],
  ['t3.medium',4,2,8,0.0416],
  ['t3.large',8,2,16,0.0832],
  ['t3.xlarge',16,4,32,0.1664],
  ['t3.2xlarge',32,8,32,0.3328],

  ['m5.large',8,2,20,0.096],
  ['m5.xlarge',16,4,40,0.192],
  ['m5.2xlarge',32,8,80,0.384],
  ['m5.4xlarge',64,16,160,0.768],
  ['m5.8xlarge',128,32,320,1.536],
  ['m5.16xlarge',256,64,640,3.072]
];
function awsGetSizesStatic() {
  return AWS_TYPES.map(([id, gb, cpu, disk, price]) => ({ slug: id, id, memory: gb*1024, vcpus: cpu, disk: disk*1024, price_monthly: price*730, available: true, regions: [], label: id, provider: 'aws' }));
}
function awsGetRegionsStatic() { return AWS_REGIONS.map(([slug, name]) => ({ slug, id: slug, name, available: true, provider: 'aws' })); }
function awsGetImagesStatic() { return [
  { label: '🟠 Ubuntu 24.04 LTS', slug: 'aws:ubuntu24.04' },
  { label: '🟠 Ubuntu 22.04 LTS', slug: 'aws:ubuntu22.04' }
]; }
async function awsGetSsmParameter(token, region, name) {
  const xml = await awsQuery(token, 'ssm', 'GetParameter', { Name: name }, region);
  return xmlText(xml, 'Value');
}

async function awsLatestUbuntuAmi(token, region, imageSlug) {
  const is2404 = String(imageSlug || '').includes('24.04');
  // Canonical publishes current Ubuntu AMI IDs through public SSM parameters.
  // This is more reliable across AWS regions than scraping DescribeImages names.
  const ssmCandidates = is2404 ? [
    '/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id',
    '/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp2/ami-id'
  ] : [
    '/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp3/ami-id',
    '/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id'
  ];
  for (const param of ssmCandidates) {
    try {
      const ami = await awsGetSsmParameter(token, region, param);
      if (ami && /^ami-[a-zA-Z0-9]+$/.test(String(ami).trim())) return String(ami).trim();
    } catch (_) {}
  }

  const ver = is2404 ? 'noble-24.04' : 'jammy-22.04';
  const nameCandidates = [
    `ubuntu/images/hvm-ssd-gp3/ubuntu-${ver}-amd64-server-*`,
    `ubuntu/images/hvm-ssd/ubuntu-${ver}-amd64-server-*`
  ];
  for (const pattern of nameCandidates) {
    try {
      const xml = await awsQuery(token, 'ec2', 'DescribeImages', {
        'Owner.1': '099720109477',
        'Filter.1.Name': 'name', 'Filter.1.Value.1': pattern,
        'Filter.2.Name': 'state', 'Filter.2.Value.1': 'available',
        'Filter.3.Name': 'architecture', 'Filter.3.Value.1': 'x86_64',
        'Filter.4.Name': 'virtualization-type', 'Filter.4.Value.1': 'hvm',
        'Filter.5.Name': 'root-device-type', 'Filter.5.Value.1': 'ebs'
      }, region);
      let best = null;
      for (const item of xmlAll(xml, 'item')) {
        const imageId = xmlText(item, 'imageId');
        const creationDate = xmlText(item, 'creationDate') || '';
        if (imageId && (!best || creationDate > best.creationDate)) best = { imageId, creationDate };
      }
      if (best) return best.imageId;
    } catch (_) {}
  }
  throw new Error('AMI Ubuntu AWS tidak ditemukan untuk region ini. Coba Ubuntu 22.04 atau region AWS lain.');
}
async function awsEnsureSecurityGroup(token, region) {
  const groupName = 'kcs-bot-rdp-sg';
  try {
    const xml = await awsQuery(token, 'ec2', 'DescribeSecurityGroups', { 'GroupName.1': groupName }, region);
    const gid = xmlText(xml, 'groupId');
    if (gid) return gid;
  } catch (_) {}
  let groupId = null;
  try {
    const xml = await awsQuery(token, 'ec2', 'CreateSecurityGroup', { GroupName: groupName, GroupDescription: 'KCS Bot SSH/RDP access' }, region);
    groupId = xmlText(xml, 'groupId');
  } catch (e) {
    const xml = await awsQuery(token, 'ec2', 'DescribeSecurityGroups', { 'GroupName.1': groupName }, region);
    groupId = xmlText(xml, 'groupId');
  }
  if (!groupId) throw new Error('Gagal membuat Security Group AWS');
  const ingress = async (idx, port) => {
    try { await awsQuery(token, 'ec2', 'AuthorizeSecurityGroupIngress', {
      GroupId: groupId, [`IpPermissions.${idx}.IpProtocol`]: 'tcp', [`IpPermissions.${idx}.FromPort`]: String(port), [`IpPermissions.${idx}.ToPort`]: String(port), [`IpPermissions.${idx}.IpRanges.1.CidrIp`]: '0.0.0.0/0'
    }, region); } catch (_) {}
  };
  const openPorts = [22, 443, 80, 8080, 587, 457, 25, 8000, 8888, 4443];
  for (let i = 0; i < openPorts.length; i++) {
    await ingress(i + 1, openPorts[i]);
  }
  return groupId;
}

function normalizeAwsRdpInstanceType(name, instanceType) {
  const n = String(name || '').toLowerCase();
  const original = String(instanceType || '').trim();

  // Hanya untuk RDP. VPS AWS biasa tidak diubah.
  if (!n.includes('rdp')) return original;

  // Tujuan: hindari instance Nitro/NVMe/UEFI seperti t3/m5/c5/c6/m6/r5/r6
  // karena installer Windows DD image user lebih stabil di disk /dev/xvda.
  //
  // Mapping diarahkan berdasarkan kelas RAM umum:
  // 0.5GB -> t2.nano
  // 1GB   -> t2.micro
  // 2GB   -> t2.small
  // 4GB   -> t2.medium
  // 8GB   -> t2.large
  // 16GB  -> t2.xlarge / m4.xlarge
  // 32GB  -> t2.2xlarge / m4.2xlarge
  // 64GB+ -> m4.4xlarge / m4.10xlarge / m4.16xlarge
  const map = {
    // t3 -> t2
    't3.nano': 't2.nano',
    't3.micro': 't2.micro',
    't3.small': 't2.small',
    't3.medium': 't2.medium',
    't3.large': 't2.large',
    't3.xlarge': 't2.xlarge',
    't3.2xlarge': 't2.2xlarge',

    // t4g tidak cocok karena ARM, arahkan ke x86 non-Nitro
    't4g.nano': 't2.nano',
    't4g.micro': 't2.micro',
    't4g.small': 't2.small',
    't4g.medium': 't2.medium',
    't4g.large': 't2.large',
    't4g.xlarge': 't2.xlarge',
    't4g.2xlarge': 't2.2xlarge',

    // m5/m6 -> m4 untuk RAM besar
    'm5.large': 't2.large',
    'm5.xlarge': 'm4.xlarge',
    'm5.2xlarge': 'm4.2xlarge',
    'm5.4xlarge': 'm4.4xlarge',
    'm5.8xlarge': 'm4.10xlarge',
    'm5.12xlarge': 'm4.10xlarge',
    'm5.16xlarge': 'm4.16xlarge',
    'm5.24xlarge': 'm4.16xlarge',

    'm6i.large': 't2.large',
    'm6i.xlarge': 'm4.xlarge',
    'm6i.2xlarge': 'm4.2xlarge',
    'm6i.4xlarge': 'm4.4xlarge',
    'm6i.8xlarge': 'm4.10xlarge',
    'm6i.12xlarge': 'm4.10xlarge',
    'm6i.16xlarge': 'm4.16xlarge',
    'm6i.24xlarge': 'm4.16xlarge',

    // c5/c6 compute optimized -> t2/m4 dengan RAM setara lebih aman untuk RDP
    'c5.large': 't2.medium',
    'c5.xlarge': 't2.large',
    'c5.2xlarge': 'm4.xlarge',
    'c5.4xlarge': 'm4.2xlarge',
    'c5.9xlarge': 'm4.4xlarge',
    'c5.12xlarge': 'm4.10xlarge',
    'c5.18xlarge': 'm4.16xlarge',
    'c5.24xlarge': 'm4.16xlarge',

    'c6i.large': 't2.medium',
    'c6i.xlarge': 't2.large',
    'c6i.2xlarge': 'm4.xlarge',
    'c6i.4xlarge': 'm4.2xlarge',
    'c6i.8xlarge': 'm4.4xlarge',
    'c6i.12xlarge': 'm4.10xlarge',
    'c6i.16xlarge': 'm4.16xlarge',
    'c6i.24xlarge': 'm4.16xlarge',

    // r5/r6 memory optimized -> m4 terbesar yang mendekati
    'r5.large': 'm4.xlarge',
    'r5.xlarge': 'm4.2xlarge',
    'r5.2xlarge': 'm4.4xlarge',
    'r5.4xlarge': 'm4.10xlarge',
    'r5.8xlarge': 'm4.16xlarge',
    'r5.12xlarge': 'm4.16xlarge',
    'r5.16xlarge': 'm4.16xlarge',
    'r5.24xlarge': 'm4.16xlarge',

    'r6i.large': 'm4.xlarge',
    'r6i.xlarge': 'm4.2xlarge',
    'r6i.2xlarge': 'm4.4xlarge',
    'r6i.4xlarge': 'm4.10xlarge',
    'r6i.8xlarge': 'm4.16xlarge',
    'r6i.12xlarge': 'm4.16xlarge',
    'r6i.16xlarge': 'm4.16xlarge',
    'r6i.24xlarge': 'm4.16xlarge'
  };

  const normalized = map[original] || original;
  if (normalized !== original) {
    console.log(`[AWS RDP] Instance type normalized for XVDA: ${original} -> ${normalized} | name=${name}`);
  }
  return normalized;
}

async function awsCreateInstance(token, name, region, instanceType, image, userData) {
  try {
    const finalInstanceType = normalizeAwsRdpInstanceType(name, instanceType);
    const imageId = String(image || '').startsWith('ami-') ? image : await awsLatestUbuntuAmi(token, region, image);
    const sg = await awsEnsureSecurityGroup(token, region);
    const encodedUserData = Buffer.from(String(userData || ''), 'utf8').toString('base64');
    const params = {
      ImageId: imageId,
      InstanceType: finalInstanceType,
      MinCount: '1', MaxCount: '1',
      UserData: encodedUserData,
      'SecurityGroupId.1': sg,
      'BlockDeviceMapping.1.DeviceName': '/dev/sda1',
      'BlockDeviceMapping.1.Ebs.VolumeSize': String(process.env.AWS_ROOT_VOLUME_GB || '100'),
      'BlockDeviceMapping.1.Ebs.VolumeType': process.env.AWS_ROOT_VOLUME_TYPE || 'gp3',
      'BlockDeviceMapping.1.Ebs.DeleteOnTermination': 'true',
      'TagSpecification.1.ResourceType': 'instance',
      'TagSpecification.1.Tag.1.Key': 'Name',
      'TagSpecification.1.Tag.1.Value': String(name || 'kcs-bot-vps').slice(0, 128)
    };
    const xml = await awsQuery(token, 'ec2', 'RunInstances', params, region);
    const instanceId = xmlText(xml, 'instanceId');
    if (!instanceId) return { dropletId: null, error: 'AWS instance ID tidak ditemukan' };
    awsInstanceRegionCache.set(instanceId, region);
    return { dropletId: instanceId, error: null, region };
  } catch (err) {
    return { dropletId: null, error: err.message || String(err) };
  }
}
function awsErrorCode(err) {
  const data = err?.response?.data || err?.message || '';
  const m = String(data).match(/<Code>([^<]+)<\/Code>/);
  return m ? m[1] : null;
}
function awsKnownRegions(preferred) {
  const regions = [];
  if (preferred) regions.push(preferred);
  for (const r of AWS_REGIONS.map(x => x[0])) if (!regions.includes(r)) regions.push(r);
  return regions;
}
async function awsDescribeInstance(token, instanceId, preferredRegion = null) {
  const defaultRegion = parseAwsToken(token).region || 'us-east-1';
  const cached = awsInstanceRegionCache.get(instanceId);
  for (const region of awsKnownRegions(preferredRegion || cached || defaultRegion)) {
    try {
      const xml = await awsQuery(token, 'ec2', 'DescribeInstances', { 'InstanceId.1': instanceId }, region);
      awsInstanceRegionCache.set(instanceId, region);
      return { xml, region };
    } catch (err) {
      if (awsErrorCode(err) !== 'InvalidInstanceID.NotFound') throw err;
    }
  }
  throw new Error(`AWS instance ${instanceId} tidak ditemukan di region yang tersedia`);
}
async function awsWaitPublicIp(token, instanceId, attempts = 30, delayMs = 10000, regionOverride = null) {
  for (let i = 0; i < attempts; i++) {
    await new Promise(r => setTimeout(r, delayMs));
    const { xml } = await awsDescribeInstance(token, instanceId, regionOverride);
    const ip = xmlText(xml, 'ipAddress') || xmlText(xml, 'publicIpAddress');
    if (ip) return ip;
  }
  return null;
}
async function awsPower(token, instanceId, action, regionOverride = null) {
  try {
    const found = await awsDescribeInstance(token, instanceId, regionOverride).catch(() => null);
    const region = found?.region || regionOverride || awsInstanceRegionCache.get(instanceId) || parseAwsToken(token).region;
    await awsQuery(token, 'ec2', action === 'on' ? 'StartInstances' : 'StopInstances', { 'InstanceId.1': instanceId }, region);
    return { ok: true, error: null };
  } catch (e) { return { ok: false, error: e.message || String(e) }; }
}
async function awsDelete(token, instanceId, regionOverride = null) {
  try {
    const found = await awsDescribeInstance(token, instanceId, regionOverride).catch(() => null);
    const region = found?.region || regionOverride || awsInstanceRegionCache.get(instanceId) || parseAwsToken(token).region;
    await awsQuery(token, 'ec2', 'TerminateInstances', { 'InstanceId.1': instanceId }, region);
    return true;
  } catch (_) { return false; }
}
async function awsAccountEmail(token) {
  try {
    const region = parseAwsToken(token).region || 'us-east-1';
    const xml = await awsQuery(token, 'sts', 'GetCallerIdentity', {}, region);
    const account = xmlText(xml, 'Account');
    const arn = xmlText(xml, 'Arn');
    return account ? `${account}${arn ? ' • ' + arn.split('/').pop() : ''}` : null;
  } catch (_) { return null; }
}
async function awsAccountInfo(token) {
  try {
    const region = parseAwsToken(token).region || 'us-east-1';
    const xml = await awsQuery(token, 'sts', 'GetCallerIdentity', {}, region);
    return { ok: true, account: { email: xmlText(xml, 'Arn') || xmlText(xml, 'Account'), uuid: xmlText(xml, 'Account') || '-', status: 'active', email_verified: null, droplet_limit: '-', floating_ip_limit: '-' }, error: null, statusCode: 200 };
  } catch (e) { return { ok: false, account: null, error: e.message || String(e), statusCode: null }; }
}
async function awsInstancesCount(token) {
  try {
    const region = parseAwsToken(token).region || 'us-east-1';
    const xml = await awsQuery(token, 'ec2', 'DescribeInstances', {
      'Filter.1.Name': 'instance-state-name', 'Filter.1.Value.1': 'pending', 'Filter.1.Value.2': 'running', 'Filter.1.Value.3': 'stopping', 'Filter.1.Value.4': 'stopped'
    }, region);
    return { ok: true, count: (xml.match(/<instanceId>/g) || []).length, error: null };
  } catch (e) { return { ok: false, count: null, error: e.message || String(e) }; }
}

async function getSizes(token) {
  if (isAwsToken(token)) return awsGetSizesStatic();
  if (isLinodeToken(token)) return await linodeGetTypes(token);
  const all = [];
  let page = 1;

  while (true) {
    const r = await axios.get(
      `${DO_API}/sizes?page=${page}&per_page=200`,
      { headers: headers(token), timeout: 30000 }
    );

    // ✅ FULL LIST: include all available droplet sizes (Basic/CPU/Memory/Storage/GPU/etc.)
    const sizes = (r.data.sizes || []).filter(s => s.available);

    all.push(...sizes);

    const links = r.data?.links?.pages;
    if (links && links.next) {
      page += 1;
      continue;
    }
    break;
  }

  // Sort by vCPUs then RAM then slug for nicer display
  return all.sort((a, b) => (a.vcpus - b.vcpus) || (a.memory - b.memory) || a.slug.localeCompare(b.slug));
}


async function getSizesForRegion(token, regionSlug) {
  const sizes = await getSizes(token);
  if (isAwsToken(token)) return sizes;
  if (isLinodeToken(token)) return sizes;
  return sizes.filter(s => {
    const regions = Array.isArray(s.regions) ? s.regions : [];
    return regions.includes(regionSlug);
  });
}

async function getRegions(token) {
  if (isAwsToken(token)) return awsGetRegionsStatic();
  if (isLinodeToken(token)) return await linodeGetRegions(token);
  const r = await axios.get(`${DO_API}/regions`, { headers: headers(token), timeout: 30000 });
  return (r.data.regions || []).filter(x => x.available);
}

async function getImages(token) {
  if (isAwsToken(token)) return awsGetImagesStatic();
  if (isLinodeToken(token)) return await linodeGetImages(token);
  const r = await axios.get(`${DO_API}/images?type=distribution`, { headers: headers(token), timeout: 30000 });
  const images = [];
  for (const img of (r.data.images || [])) {
    const slug = img.slug;
    if (slug === 'ubuntu-22-04-x64' || slug === 'ubuntu-24-04-x64') {
      images.push({ label: `🟠 Ubuntu ${img.name}`, slug });
    }
    if (slug === 'debian-11-x64' || slug === 'debian-12-x64') {
      images.push({ label: `🔵 Debian ${img.name}`, slug });
    }
  }
  return images;
}

async function createDroplet(token, name, region, size, image, userData) {
  if (isAwsToken(token)) return await awsCreateInstance(token, name, region, size, image, userData);
  if (isLinodeToken(token)) {
    const parsedPass = parseRootPasswordFromCloudInit(userData);
    const rootPass = isStrongLinodeRootPassword(parsedPass) ? parsedPass : randomRootPassword();
    return await linodeCreateInstance(token, name, region, size, image || 'linode/ubuntu22.04', rootPass, userData);
  }
  try {
    const r = await axios.post(
      `${DO_API}/droplets`,
      { name, region, size, image, user_data: userData },
      { headers: headers(token), timeout: 30000 }
    );

    if (r.status !== 202 || !r.data?.droplet?.id) {
      return { dropletId: null, error: r.data?.message || 'Failed to create droplet' };
    }
    return { dropletId: r.data.droplet.id, error: null };
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    const msg = data?.message || err.message || 'Unknown error';
    return { dropletId: null, error: status ? `HTTP ${status}: ${msg}` : msg };
  }
}

function parseRootPasswordFromCloudInit(userData) {
  const m = String(userData || '').match(/root:([^\n\r]+)/);
  return m ? m[1].trim() : null;
}
function isStrongLinodeRootPassword(p) {
  const x = String(p || '');
  return x.length >= 11 && x.length <= 128 && /[a-z]/.test(x) && /[A-Z]/.test(x) && /\d/.test(x) && /[^A-Za-z0-9]/.test(x);
}

function randomRootPassword() {
  const raw = require('crypto').randomBytes(48).toString('base64').replace(/[\/+=]/g, '');
  return `Kcs${raw.slice(0, 18)}9!a`;
}

async function waitPublicIp(token, dropletId, attempts = 20, delayMs = 10000, regionOverride = null) {
  if (isAwsToken(token)) return await awsWaitPublicIp(token, dropletId, attempts, delayMs, regionOverride);
  if (isLinodeToken(token)) return await linodeWaitPublicIp(token, dropletId, attempts, delayMs);
  for (let i = 0; i < attempts; i++) {
    await new Promise(r => setTimeout(r, delayMs));
    const r = await axios.get(`${DO_API}/droplets/${dropletId}`, { headers: headers(token), timeout: 30000 });
    const nets = r.data?.droplet?.networks?.v4 || [];
    const pub = nets.find(n => n.type === 'public');
    if (pub?.ip_address) return pub.ip_address;
  }
  return null;
}

async function powerDroplet(token, dropletId, action, regionOverride = null) {
  if (isAwsToken(token)) return await awsPower(token, dropletId, action, regionOverride);
  if (isLinodeToken(token)) return await linodePower(token, dropletId, action);
  try {
    const type = action === 'on' ? 'power_on' : 'power_off';
    const r = await axios.post(`${DO_API}/droplets/${dropletId}/actions`, { type }, { headers: headers(token), timeout: 30000 });
    return { ok: r.status === 201 || r.status === 202, error: null };
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    const msg = data?.message || err.message || 'Unknown error';
    return { ok: false, error: status ? `HTTP ${status}: ${msg}` : msg };
  }
}

async function deleteDroplet(token, dropletId, regionOverride = null) {
  if (isAwsToken(token)) return await awsDelete(token, dropletId, regionOverride);
  if (isLinodeToken(token)) return await linodeDelete(token, dropletId);
  try {
    const r = await axios.delete(`${DO_API}/droplets/${dropletId}`, { headers: headers(token), timeout: 30000 });
    return r.status === 204;
  } catch (err) {
    return false;
  }
}

// Fetch account email for a given DigitalOcean API token
async function getAccountEmail(token) {
  if (isAwsToken(token)) return await awsAccountEmail(token);
  if (isLinodeToken(token)) {
    try {
      const r = await axios.get(`${LINODE_API}/profile`, { headers: headers(token), timeout: 30000 });
      return r.data?.email || r.data?.username || null;
    } catch (_) { return null; }
  }
  // DO API can occasionally return 429/5xx or transient network errors.
  // We retry a few times so admin menus can reliably show: email - API#X
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  let backoff = 800;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await axios.get(`${DO_API}/account`, { headers: headers(token), timeout: 30000 });
      return r.data?.account?.email || null;
    } catch (err) {
      const status = err?.response?.status;
      const code = err?.code;

      // Retry on rate limit, server errors, and common transient network issues
      const transient = status === 429 || (status >= 500 && status <= 599) ||
        ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'].includes(code);

      if (!transient) return null;
      if (attempt < 4) {
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 6000);
        continue;
      }
      return null;
    }
  }
  return null;
}


async function getAccountInfo(token) {
  if (isAwsToken(token)) return await awsAccountInfo(token);
  if (isLinodeToken(token)) {
    try {
      const [profile, accountRes] = await Promise.allSettled([
        axios.get(`${LINODE_API}/profile`, { headers: headers(token), timeout: 30000 }),
        axios.get(`${LINODE_API}/account`, { headers: headers(token), timeout: 30000 })
      ]);
      const prof = profile.status === 'fulfilled' ? (profile.value.data || {}) : {};
      const acct = accountRes.status === 'fulfilled' ? (accountRes.value.data || {}) : {};
      const account = {
        email: prof.email || acct.email || prof.username || null,
        uuid: acct.uuid || prof.uid || '-',
        status: acct.active_since || prof.email ? 'active' : 'unknown',
        email_verified: prof.email ? true : null,
        droplet_limit: acct.active_promotions ? '-' : '-',
        floating_ip_limit: '-'
      };
      return { ok: true, account, error: null, statusCode: 200 };
    } catch (err) {
      const status = err.response?.status;
      const data = err.response?.data;
      const msg = data?.errors?.map(e => e.reason || e.field).filter(Boolean).join('; ') || data?.message || err.message || 'Unknown error';
      return { ok: false, account: null, error: status ? `HTTP ${status}: ${msg}` : msg, statusCode: status || null };
    }
  }
  try {
    const r = await axios.get(`${DO_API}/account`, { headers: headers(token), timeout: 30000 });
    const account = r.data?.account || {};
    return { ok: true, account, error: null, statusCode: r.status };
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    const msg = data?.message || err.message || 'Unknown error';
    return { ok: false, account: null, error: status ? `HTTP ${status}: ${msg}` : msg, statusCode: status || null };
  }
}

async function getCustomerBalance(token) {
  if (isAwsToken(token)) return { ok: true, balance: { account_balance: '-', month_to_date_balance: '-', month_to_date_usage: '-', generated_at: new Date().toISOString() }, error: null, statusCode: 200 };
  if (isLinodeToken(token)) {
    try {
      const r = await axios.get(`${LINODE_API}/account`, { headers: headers(token), timeout: 30000 });
      const a = r.data || {};
      return { ok: true, balance: { account_balance: a.balance, month_to_date_balance: a.balance_uninvoiced, month_to_date_usage: a.balance_uninvoiced, generated_at: new Date().toISOString() }, error: null, statusCode: r.status };
    } catch (err) {
      const status = err.response?.status;
      const data = err.response?.data;
      const msg = data?.errors?.map(e => e.reason || e.field).filter(Boolean).join('; ') || data?.message || err.message || 'Unknown error';
      return { ok: false, balance: null, error: status ? `HTTP ${status}: ${msg}` : msg, statusCode: status || null };
    }
  }
  try {
    const r = await axios.get(`${DO_API}/customers/my/balance`, { headers: headers(token), timeout: 30000 });
    return { ok: true, balance: r.data || {}, error: null, statusCode: r.status };
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    const msg = data?.message || err.message || 'Unknown error';
    return { ok: false, balance: null, error: status ? `HTTP ${status}: ${msg}` : msg, statusCode: status || null };
  }
}

async function getDropletsCount(token) {
  if (isAwsToken(token)) return await awsInstancesCount(token);
  if (isLinodeToken(token)) {
    try {
      const r = await axios.get(`${LINODE_API}/linode/instances?page=1&page_size=1`, { headers: headers(token), timeout: 30000 });
      return { ok: true, count: Number(r.data?.results ?? (Array.isArray(r.data?.data) ? r.data.data.length : 0)), error: null };
    } catch (err) {
      const status = err.response?.status;
      const data = err.response?.data;
      const msg = data?.errors?.map(e => e.reason || e.field).filter(Boolean).join('; ') || data?.message || err.message || 'Unknown error';
      return { ok: false, count: null, error: status ? `HTTP ${status}: ${msg}` : msg };
    }
  }
  try {
    let page = 1;
    let total = null;
    let counted = 0;
    while (true) {
      const r = await axios.get(`${DO_API}/droplets?page=${page}&per_page=200`, { headers: headers(token), timeout: 30000 });
      const droplets = Array.isArray(r.data?.droplets) ? r.data.droplets : [];
      counted += droplets.length;
      if (r.data?.meta && typeof r.data.meta.total === 'number') total = r.data.meta.total;
      const links = r.data?.links?.pages;
      if (links && links.next) {
        page += 1;
        continue;
      }
      break;
    }
    return { ok: true, count: total !== null ? total : counted, error: null };
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    const msg = data?.message || err.message || 'Unknown error';
    return { ok: false, count: null, error: status ? `HTTP ${status}: ${msg}` : msg };
  }
}

async function getBillingHistory(token) {
  if (isAwsToken(token) || isLinodeToken(token)) return { ok: true, entries: [], error: null };
  try {
    const entries = [];
    let page = 1;
    while (page <= 3) {
      const r = await axios.get(`${DO_API}/customers/my/billing_history?page=${page}&per_page=200`, { headers: headers(token), timeout: 30000 });
      const rows = Array.isArray(r.data?.billing_history) ? r.data.billing_history : [];
      entries.push(...rows);
      const links = r.data?.links?.pages;
      if (links && links.next) {
        page += 1;
        continue;
      }
      break;
    }
    return { ok: true, entries, error: null };
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    const msg = data?.message || err.message || 'Unknown error';
    return { ok: false, entries: [], error: status ? `HTTP ${status}: ${msg}` : msg };
  }
}

function numberFromMoney(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return value;
  const n = Number(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function summarizeCreditsFromHistory(entries) {
  const rows = Array.isArray(entries) ? entries : [];
  let detectedTotal = 0;
  const creditRows = [];
  for (const row of rows) {
    const desc = String(row.description || row.name || row.type || row.invoice_id || '').trim();
    const hay = `${desc} ${row.amount || ''} ${row.balance || ''}`.toLowerCase();
    const isCredit = /credit|promo|promotional|github|student|coupon|trial|adjustment/.test(hay);
    if (!isCredit) continue;
    const amount = numberFromMoney(row.amount ?? row.credit ?? row.total ?? row.balance);
    if (amount) detectedTotal += Math.abs(amount);
    creditRows.push({
      date: row.date || row.invoice_period || row.created_at || '-',
      description: desc || 'Credit / adjustment',
      amount: amount || null
    });
  }
  return { detectedTotal, rows: creditRows.slice(0, 5) };
}

function classifyAccountStatus(accountResult) {
  if (!accountResult || !accountResult.ok) {
    const code = accountResult?.statusCode;
    if (code === 401 || code === 403) return 'INVALID/LOCKED';
    return 'ERROR';
  }
  const raw = String(accountResult.account?.status || 'unknown').toLowerCase();
  if (raw === 'active') return 'ACTIVE';
  if (raw === 'warning') return 'WARNING';
  if (raw === 'locked') return 'LOCKED';
  if (raw === 'suspended' || raw === 'suspend') return 'SUSPENDED';
  return raw.toUpperCase();
}

async function getAccountHealth(token) {
  const [accountResult, balanceResult, dropletsResult, historyResult] = await Promise.all([
    getAccountInfo(token),
    getCustomerBalance(token),
    getDropletsCount(token),
    getBillingHistory(token)
  ]);
  const creditSummary = summarizeCreditsFromHistory(historyResult.entries);
  return {
    ok: accountResult.ok,
    status: classifyAccountStatus(accountResult),
    account: accountResult.account,
    balance: balanceResult.balance,
    dropletCount: dropletsResult.count,
    creditSummary,
    accountError: accountResult.error,
    balanceError: balanceResult.error,
    dropletsError: dropletsResult.error,
    billingHistoryError: historyResult.error,
    accountStatusCode: accountResult.statusCode,
    balanceStatusCode: balanceResult.statusCode
  };
}

module.exports = {
  getSizes,
  getSizesForRegion,
  getRegions,
  getImages,
  createDroplet,
  waitPublicIp,
  deleteDroplet,
  powerDroplet,
  linodeSetDirectDisk,
  getAccountEmail,
  getAccountInfo,
  getCustomerBalance,
  getDropletsCount,
  getBillingHistory,
  getAccountHealth,
  isLinodeToken,
  isAwsToken,
  makeAwsToken,
  parseAwsToken,
  providerName
};
