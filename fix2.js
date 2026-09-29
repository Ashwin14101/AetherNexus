const fs = require('fs');

let s = fs.readFileSync('server.ts', 'utf8');

// Fix getLatestMetrics
s = s.replace(
`  const pipeline = [
    { $sort: { timestamp: -1 } },
    {
      $group: {
        _id: '$region',
        computeLoadPercentage: { $first: '$computeLoadPercentage' },
        volatileMemoryAllocationGb: { $first: '$volatileMemoryAllocationGb' },
        clusterOperationalStatus: { $first: '$clusterOperationalStatus' },
        timestamp: { $first: '$timestamp' },
      },
    },
  ];

  const results = await db.collection<any>('server_health').aggregate(pipeline).toArray();

  const infrastructureState: Record<string, any> = {
    usEastCluster: {
      computeLoadPercentage: 0,
      volatileMemoryAllocationGb: 0,
      clusterOperationalStatus: 'STABLE',
    },
    euWestCluster: {
      computeLoadPercentage: 0,
      volatileMemoryAllocationGb: 0,
      clusterOperationalStatus: 'STABLE',
    },
    apSouthCluster: {
      computeLoadPercentage: 0,
      volatileMemoryAllocationGb: 0,
      clusterOperationalStatus: 'STABLE',
    },
  };

  for (const doc of results) {
    const key = REGION_TO_KEY[doc._id];
    if (key && infrastructureState[key]) {
      infrastructureState[key] = {
        computeLoadPercentage: doc.computeLoadPercentage,
        volatileMemoryAllocationGb: doc.volatileMemoryAllocationGb,
        clusterOperationalStatus: doc.clusterOperationalStatus,
      };
    }
  }`,
`  const results = await db.collection<any>('node_states').find({}).toArray();

  const infrastructureState: Record<string, any> = {
    usEastCluster: { currentLoadPercentage: 0, metrics: { ram: 0 }, status: 'STABLE' },
    euWestCluster: { currentLoadPercentage: 0, metrics: { ram: 0 }, status: 'STABLE' },
    apSouthCluster: { currentLoadPercentage: 0, metrics: { ram: 0 }, status: 'STABLE' },
  };

  for (const doc of results) {
    const key = doc.nodeId;
    if (key && infrastructureState[key]) {
      infrastructureState[key] = {
        currentLoadPercentage: doc.currentLoadPercentage,
        metrics: doc.metrics,
        status: doc.status,
      };
    }
  }`
);

// Map region name in mitigateCluster calls inside /api/mitigate
s = s.replace(
`    // GAP-008: Idempotency guard — suppress duplicate mitigation if node is already HEALING
    if (await ensureDbConnection()) {
      const existingNode = await db.collection<any>('node_states').findOne({ nodeId: targetClusterRegion });
      if (existingNode?.status === 'HEALING' && existingNode?.currentAction === 'CLEAR_CACHE') {
        console.log(\`[mitigate] Duplicate suppressed — \${targetClusterRegion} is already HEALING with CLEAR_CACHE.\`);
        return res.json({ success: true, message: 'Mitigation already running. Duplicate suppressed.' });
      }
      // Mark node as HEALING before dispatching so concurrent calls are idempotent
      await db.collection<any>('node_states').updateOne(
        { nodeId: targetClusterRegion },
        { $set: { status: 'HEALING', currentAction: 'CLEAR_CACHE', isQuarantined: false, updatedAt: new Date() } },
        { upsert: true }
      );
    }

    // Execute mitigation: clear memory arrays, stop math loops, restore network
    await mitigateCluster(targetClusterRegion as Region);
    
    if (await ensureDbConnection()) {
      await recalculateRouting(db);
      // Clear HEALING flag after successful mitigation
      await db.collection<any>('node_states').updateOne(
        { nodeId: targetClusterRegion },
        { $set: { status: 'STABLE', currentAction: null, isQuarantined: false, updatedAt: new Date() } },
        { upsert: true }
      );
    }`,
`    // Fix name mapping
    let clusterId = targetClusterRegion;
    if (clusterId === 'US-East' || clusterId === 'US-East-1') clusterId = 'usEastCluster';
    if (clusterId === 'EU-West' || clusterId === 'EU-West-1') clusterId = 'euWestCluster';
    if (clusterId === 'AP-South' || clusterId === 'AP-South-1') clusterId = 'apSouthCluster';

    if (await ensureDbConnection()) {
      const existingNode = await db.collection<any>('node_states').findOne({ nodeId: clusterId });
      if (existingNode?.status === 'HEALING' && existingNode?.currentAction === 'CLEAR_CACHE') {
        console.log(\`[mitigate] Duplicate suppressed — \${clusterId} is already HEALING with CLEAR_CACHE.\`);
        return res.json({ success: true, message: 'Mitigation already running. Duplicate suppressed.' });
      }
      await db.collection<any>('node_states').updateOne(
        { nodeId: clusterId },
        { $set: { status: 'HEALING', currentAction: 'CLEAR_CACHE', isQuarantined: false, updatedAt: new Date() } },
        { upsert: true }
      );
    }

    await mitigateCluster(clusterId as Region);
    
    if (await ensureDbConnection()) {
      await recalculateRouting(db);
      await db.collection<any>('node_states').updateOne(
        { nodeId: clusterId },
        { $set: { status: 'STABLE', currentAction: null, isQuarantined: false, updatedAt: new Date() } },
        { upsert: true }
      );
    }`
);

// Fix chaos endpoints inserts
s = s.replace(
`      await db.collection<any>('server_health').insertOne(metricDoc);
      // GAP-009: Write quarantine lock to node_states
      await db.collection<any>('node_states').updateOne(
        { nodeId: targetClusterRegion },
        { $set: { status: metricDoc.clusterOperationalStatus, isQuarantined: true, updatedAt: new Date() } },
        { upsert: true }
      );`,
`      // Removed server_health insert
      await db.collection<any>('node_states').updateOne(
        { nodeId: targetClusterRegion },
        { $set: { status: metricDoc.clusterOperationalStatus, isQuarantined: true, currentLoadPercentage: metricDoc.computeLoadPercentage, metrics: { cpu: metricDoc.computeLoadPercentage, ram: metricDoc.volatileMemoryAllocationGb * 1024, activeConnections: metricDoc.networkPackets ? 150 : 0, responseTimeMs: 20, timestamp: new Date().toISOString() }, updatedAt: new Date() } },
        { upsert: true }
      );`
);

s = s.replace(
`    await db.collection<any>('server_health').insertOne(metricDoc);

    await db.collection<any>('chaos_locks').updateOne(
      { region: normRegion },
      {
        $set: {
          type: 'cpu_lock',
          computeLoadPercentage: 99.8,
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );

    // GAP-009: Write quarantine lock to node_states
    await db.collection<any>('node_states').updateOne(
      { nodeId: normRegion },
      { $set: { status: 'CRITICAL', isQuarantined: true, updatedAt: new Date() } },
      { upsert: true }
    );`,
`    await db.collection<any>('chaos_locks').updateOne(
      { region: normRegion },
      {
        $set: {
          type: 'cpu_lock',
          computeLoadPercentage: 99.8,
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );

    let clusterId = normRegion === 'US-East' ? 'usEastCluster' : normRegion === 'EU-West' ? 'euWestCluster' : 'apSouthCluster';
    await db.collection<any>('node_states').updateOne(
      { nodeId: clusterId },
      { $set: { status: 'CRITICAL', currentLoadPercentage: 99.8, metrics: { cpu: 99.8, ram: 12.0 * 1024, activeConnections: 150, responseTimeMs: 20, timestamp: new Date().toISOString() }, isQuarantined: true, updatedAt: new Date() } },
      { upsert: true }
    );`
);

s = s.replace(
`    await db.collection<any>('server_health').insertOne(metricDoc);

    await db.collection<any>('chaos_locks').updateOne(
      { region: normRegion },
      {
        $set: {
          type: 'network_lock',
          networkPackets: 0,
          clusterOperationalStatus: 'CRITICAL_NETWORK_DOWN',
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );

    // GAP-009: Write quarantine lock to node_states
    await db.collection<any>('node_states').updateOne(
      { nodeId: normRegion },
      { $set: { status: 'CRITICAL_NETWORK_DOWN', isQuarantined: true, updatedAt: new Date() } },
      { upsert: true }
    );`,
`    await db.collection<any>('chaos_locks').updateOne(
      { region: normRegion },
      {
        $set: {
          type: 'network_lock',
          networkPackets: 0,
          clusterOperationalStatus: 'CRITICAL_NETWORK_DOWN',
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );

    let clusterId = normRegion === 'US-East' ? 'usEastCluster' : normRegion === 'EU-West' ? 'euWestCluster' : 'apSouthCluster';
    await db.collection<any>('node_states').updateOne(
      { nodeId: clusterId },
      { $set: { status: 'CRITICAL_NETWORK_DOWN', currentLoadPercentage: 0, metrics: { cpu: 0, ram: 0, activeConnections: 0, responseTimeMs: 20, timestamp: new Date().toISOString() }, isQuarantined: true, updatedAt: new Date() } },
      { upsert: true }
    );`
);

s = s.replace(
`    for (const r of regions) {
      await db.collection<any>('server_health').insertOne({
        timestamp: restoreTime,
        region: r,
        computeLoadPercentage: parseFloat((25.0 + Math.random() * 5.0).toFixed(1)),
        volatileMemoryAllocationGb: parseFloat((4.5 + Math.random() * 1.5).toFixed(1)),
        clusterOperationalStatus: 'STABLE',
      });
    }`,
`    for (const r of regions) {
      let clusterId = r === 'US-East' ? 'usEastCluster' : r === 'EU-West' ? 'euWestCluster' : 'apSouthCluster';
      await db.collection<any>('node_states').updateOne(
        { nodeId: clusterId },
        { $set: { status: 'STABLE', currentLoadPercentage: 25.0, metrics: { cpu: 25.0, ram: 4500, activeConnections: 150, responseTimeMs: 20, timestamp: new Date().toISOString() }, isQuarantined: false, updatedAt: new Date() } },
        { upsert: true }
      );
    }`
);

fs.writeFileSync('server.ts', s);
console.log("Fixed server.ts chaos and mitigations");
