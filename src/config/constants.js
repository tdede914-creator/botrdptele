const { WINDOWS_VERSIONS } = require('./windows');
const { VPS_CONFIGS, INSTALLATION_COST, DEDICATED_INSTALLATION_COST } = require('./vps');

const DEDICATED_OS_VERSIONS = [
    { id: 0, name: 'Windows 10 AtlasOS', version: 'win_10atlas', price: 5000 },
    { id: 1, name: 'Windows 10 Ghost', version: 'win_10ghost', price: 5000 },
    { id: 2, name: 'Windows Server 2022', version: 'win_22', price: 5000 },
    { id: 3, name: 'Windows Server 2019', version: 'win_19', price: 5000 },
    { id: 4, name: 'Windows Server 2008', version: 'win_2008', price: 5000 },
    { id: 5, name: 'Windows Server 2012 R2', version: 'win_2012R2', price: 5000 },
    { id: 6, name: 'Windows Server 2016', version: 'win_2016', price: 5000 },
    { id: 7, name: 'Windows 7', version: 'win_7', price: 5000 },
    { id: 8, name: 'Windows 10 Enterprise', version: 'win_10_ent', price: 5000 },
    { id: 9, name: 'Windows 11 Pro', version: 'win_11_pro', price: 5000 },
    { id: 10, name: 'Windows Server 2022 Lite', version: 'win_2022_lite', price: 5000 },
    { id: 11, name: 'Windows Server 2016 Lite', version: 'win_2016_lite', price: 5000 },
    { id: 12, name: 'Windows Server 2012 R2 Lite', version: 'win_2012R2_lite', price: 5000 },
    { id: 13, name: 'Windows 7 SP1 Lite', version: 'win_7_sp1_lite', price: 5000 },
    { id: 14, name: 'Windows Server 2012 R2 UEFI', version: 'win_2012R2_uefi', price: 5000 },
    { id: 15, name: 'Windows Server 2016 UEFI', version: 'win_2016_uefi', price: 5000 },
    { id: 16, name: 'Windows Server 2019 UEFI', version: 'win_2019_uefi', price: 5000 },
    { id: 17, name: 'Windows Server 2022 UEFI', version: 'win_2022_uefi', price: 5000 },
    { id: 18, name: 'Windows 10 UEFI', version: 'win_10_uefi', price: 5000 },
    { id: 19, name: 'Windows 11 UEFI', version: 'win_11_uefi', price: 5000 },
    { id: 20, name: 'Windows Server 2025', version: 'win_2025', price: 5000 }
];

module.exports = {
    WINDOWS_VERSIONS,
    VPS_CONFIGS,
    INSTALLATION_COST,
    DEDICATED_INSTALLATION_COST,
    DEDICATED_OS_VERSIONS
};