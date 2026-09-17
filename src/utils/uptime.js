const startTime = Date.now();

function getUptime() {
  const uptime = Date.now() - startTime;
  const days = Math.floor(uptime / (24 * 60 * 60 * 1000));
  const hours = Math.floor((uptime % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  const minutes = Math.floor((uptime % (60 * 60 * 1000)) / (60 * 1000));
  
  let uptimeText = '';
  if (days > 0) uptimeText += `${days}d `;
  if (hours > 0) uptimeText += `${hours}h `;
  uptimeText += `${minutes}m`;
  
  return uptimeText;
}

module.exports = {
  getUptime
};