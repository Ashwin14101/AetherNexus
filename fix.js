const fs = require('fs');

// 1. loadbalancer.ts
let lb = fs.readFileSync('loadbalancer.ts', 'utf8');
lb = lb.replace(
`  for (const r of regions) {
    const latest = await db.collection<any>('server_health')
      .findOne({ region: r }, { sort: { timestamp: -1 } });

    if (latest) {
      const status = latest.clusterOperationalStatus;
      if (status === 'CRITICAL_NETWORK_DOWN' || status === 'CRITICAL' || latest.computeLoadPercentage >= 90 || latest.networkPackets === 0) {
        statusMap[r] = false;
      }
    }
  }`,
`  for (const r of regions) {
    const clusterId = r === 'US-East' ? 'usEastCluster' : r === 'EU-West' ? 'euWestCluster' : 'apSouthCluster';
    const latest = await db.collection<any>('node_states')
      .findOne({ nodeId: clusterId });

    if (latest) {
      const status = latest.status;
      if (status === 'CRITICAL_NETWORK_DOWN' || status === 'CRITICAL' || latest.currentLoadPercentage >= 90 || latest.metrics?.activeConnections === 0) {
        statusMap[r] = false;
      }
    }
  }`
);
fs.writeFileSync('loadbalancer.ts', lb);

// 2. egressBroadcaster.js
let eb = fs.readFileSync('dist/egressBroadcaster.js', 'utf8');
eb = eb.replace(
`        const pipeline = [
            { $sort: { timestamp: -1 } },
            {
                $group: {
                    _id: '$region',
                    computeLoadPercentage: { $first: '$computeLoadPercentage' },
                    volatileMemoryAllocationGb: { $first: '$volatileMemoryAllocationGb' },
                    clusterOperationalStatus: { $first: '$clusterOperationalStatus' },
                },
            },
        ];
        const results = await db.collection('server_health').aggregate(pipeline).toArray();
        const infrastructureState = {
            usEastCluster: { computeLoadPercentage: 0, volatileMemoryAllocationGb: 0, clusterOperationalStatus: 'STABLE' },
            euWestCluster: { computeLoadPercentage: 0, volatileMemoryAllocationGb: 0, clusterOperationalStatus: 'STABLE' },
            apSouthCluster: { computeLoadPercentage: 0, volatileMemoryAllocationGb: 0, clusterOperationalStatus: 'STABLE' },
        };
        results.forEach((r) => {
            const mappedId = r._id === 'US-East' ? 'usEastCluster' 
                           : r._id === 'EU-West' ? 'euWestCluster'
                           : r._id === 'AP-South' ? 'apSouthCluster'
                           : r._id;
            if (infrastructureState[mappedId]) {
                infrastructureState[mappedId] = {
                    computeLoadPercentage: r.computeLoadPercentage,
                    volatileMemoryAllocationGb: r.volatileMemoryAllocationGb,
                    clusterOperationalStatus: r.clusterOperationalStatus,
                };
            }
        });`,
`        const results = await db.collection('node_states').find({}).toArray();
        const infrastructureState = {
            usEastCluster: { computeLoadPercentage: 0, volatileMemoryAllocationGb: 0, clusterOperationalStatus: 'STABLE' },
            euWestCluster: { computeLoadPercentage: 0, volatileMemoryAllocationGb: 0, clusterOperationalStatus: 'STABLE' },
            apSouthCluster: { computeLoadPercentage: 0, volatileMemoryAllocationGb: 0, clusterOperationalStatus: 'STABLE' },
        };
        results.forEach((r) => {
            const mappedId = r.nodeId;
            if (infrastructureState[mappedId]) {
                infrastructureState[mappedId] = {
                    computeLoadPercentage: r.currentLoadPercentage,
                    volatileMemoryAllocationGb: (r.metrics?.ram || 0) / 1024,
                    clusterOperationalStatus: r.status,
                };
            }
        });`
);
fs.writeFileSync('dist/egressBroadcaster.js', eb);

// 3. App.jsx
let app = fs.readFileSync('dashboard/src/App.jsx', 'utf8');
app = app.replace(
`        const cpu = m?.computeLoadPercentage ?? 0;
        const dbStatus = m?.clusterOperationalStatus;`,
`        const cpu = m?.currentLoadPercentage ?? m?.computeLoadPercentage ?? 0;
        const dbStatus = m?.status ?? m?.clusterOperationalStatus;`
).replace(
`        const cpu = m?.computeLoadPercentage ?? 0;
        const dbStatus = m?.clusterOperationalStatus;`,
`        const cpu = m?.currentLoadPercentage ?? m?.computeLoadPercentage ?? 0;
        const dbStatus = m?.status ?? m?.clusterOperationalStatus;`
).replace(
`const logEntry = \`[\${new Date().toLocaleTimeString()}] \${regionId.toUpperCase()} | CPU: \${cpu.toFixed(1)}% | RAM: \${m?.volatileMemoryAllocationGb?.toFixed(1)}GB | Status: \${dbStatus}\`;`,
`const ram = m?.metrics?.ram ? (m.metrics.ram / 1024) : (m?.volatileMemoryAllocationGb || 0);
        const logEntry = \`[\${new Date().toLocaleTimeString()}] \${regionId.toUpperCase()} | CPU: \${cpu.toFixed(1)}% | RAM: \${ram.toFixed(1)}GB | Status: \${dbStatus}\`;`
).replace(
`              const cpu = metrics?.computeLoadPercentage ?? 0;
              const dbStatus = metrics?.clusterOperationalStatus;`,
`              const cpu = metrics?.currentLoadPercentage ?? metrics?.computeLoadPercentage ?? 0;
              const dbStatus = metrics?.status ?? metrics?.clusterOperationalStatus;`
);
fs.writeFileSync('dashboard/src/App.jsx', app);

console.log("Fixes applied to loadbalancer, broadcaster, and App.jsx");
