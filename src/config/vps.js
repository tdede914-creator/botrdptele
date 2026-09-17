const VPS_CONFIGS = [
    {
        id: 1,
        name: 'VPS 4 Core 8GB',
        specs: {
            cpu: 4,
            ram: 6,
            storage: 140
        }
    },
    {
        id: 2,
        name: 'VPS 2 Core 4GB',
        specs: {
            cpu: 2,
            ram: 2,
            storage: 70
        }
    }
];

const DEDICATED_INSTALLATION_COST = 5000; // 5k per Dedicated RDP installation
const INSTALLATION_COST = 5000;

module.exports = {
    VPS_CONFIGS,
    INSTALLATION_COST,
    DEDICATED_INSTALLATION_COST
};
