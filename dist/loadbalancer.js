"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeRegion = normalizeRegion;
exports.recalculateRouting = recalculateRouting;
exports.getDistributionMap = getDistributionMap;
/**
 * Normalizes user-facing/telemetry region names to a standard key format.
 */
function normalizeRegion(region) {
    const r = region.trim().toUpperCase();
    if (r === 'US-EAST' || r === 'US-EAST-1' || r === 'USEASTCLUSTER')
        return 'US-East';
    if (r === 'EU-WEST' || r === 'EU-WEST-1' || r === 'EUWESTCLUSTER')
        return 'EU-West';
    if (r === 'AP-SOUTH' || r === 'AP-SOUTH-1' || r === 'APSOUTHCLUSTER')
        return 'AP-South';
    throw new Error(`Unrecognized region identifier: ${region}`);
}
/**
 * Recalculates live paths and redistributes the traffic weight.
 * If US-East-1 drops or crashes (e.g. status is CRITICAL_NETWORK_DOWN),
 * traffic weight is equally distributed between EU-West-1 and AP-South-1 (50% each).
 * Otherwise, traffic is divided evenly among all three regions (33.3% each).
 * Saves the state directly to the database in load_balancer_state collection.
 */
async function recalculateRouting(db) {
    const regions = ['US-East', 'EU-West', 'AP-South'];
    const statusMap = {
        'US-East': true, // true = active/healthy, false = crashed/down
        'EU-West': true,
        'AP-South': true
    };
    // Query latest status for all three regions
    for (const r of regions) {
        const clusterId = r === 'US-East' ? 'usEastCluster' : r === 'EU-West' ? 'euWestCluster' : 'apSouthCluster';
        const latest = await db.collection('node_states')
            .findOne({ nodeId: clusterId });
        if (latest) {
            const status = latest.status;
            if (status === 'CRITICAL_NETWORK_DOWN' || status === 'CRITICAL' || latest.currentLoadPercentage >= 90 || latest.metrics?.activeConnections === 0) {
                statusMap[r] = false;
            }
        }
    }
    // Calculate active regions list
    const activeRegions = Object.keys(statusMap).filter(r => statusMap[r]);
    const regionKeys = {
        'US-East': 'US-East-1',
        'EU-West': 'EU-West-1',
        'AP-South': 'AP-South-1',
    };
    let distributionMap = {
        'US-East-1': 0,
        'EU-West-1': 0,
        'AP-South-1': 0,
    };
    if (activeRegions.length === 0) {
        // All regions down — routing disabled
        console.log('[loadbalancer] Emergency: All regions down. Routing disabled (0%).');
    }
    else {
        // Integer-division algorithm: guarantees sum = exactly 100 with no floating-point drift
        const healthyCount = activeRegions.length;
        const baseLoad = Math.floor(100 / healthyCount);
        let remainder = 100 % healthyCount;
        for (const r of activeRegions) {
            const distKey = regionKeys[r];
            distributionMap[distKey] = baseLoad + (remainder > 0 ? 1 : 0);
            if (remainder > 0)
                remainder--;
        }
        console.log(`[loadbalancer] Active regions: ${activeRegions.join(', ')}. Distribution:`, distributionMap);
    }
    // Save the state directly to database, changing tracking variable called traffic_distribution_map
    await db.collection('load_balancer_state').updateOne({ _id: 'current_state' }, {
        $set: {
            traffic_distribution_map: distributionMap,
            updatedAt: new Date(),
        },
    }, { upsert: true });
    return distributionMap;
}
/**
 * Retrieves the current traffic distribution map from the database.
 * If not set, defaults to the normal even distribution.
 */
async function getDistributionMap(db) {
    const stateDoc = await db.collection('load_balancer_state').findOne({ _id: 'current_state' });
    if (stateDoc && stateDoc.traffic_distribution_map) {
        return stateDoc.traffic_distribution_map;
    }
    return {
        'US-East-1': 33.3,
        'EU-West-1': 33.3,
        'AP-South-1': 33.4,
    };
}
