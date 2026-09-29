import React from 'react';

const GATEWAY_URL = import.meta.env.VITE_API_GATEWAY_URL || 'http://localhost:4000';

const clusters = [
  { id: 'usEastCluster', label: 'US-East', region: 'US-East-1' },
  { id: 'euWestCluster', label: 'EU-West', region: 'EU-West-1' },
  { id: 'apSouthCluster', label: 'AP-South', region: 'AP-South-1' }
];

// PWR-05: Named cascade scenario presets
const cascadeScenarios = [
  { label: 'Full Cascade', scenario: 'full-cascade' },
  { label: 'Rolling Degradation', scenario: 'rolling-degradation' },
];

export default function DevOpsControls({ onMitigate }) {
  const handleInject = async (region, faultType) => {
    // BUG-A10 FIX: Use dedicated endpoint for each fault type with correct faultType strings.
    // '/api/chaos/spike-cpu' and '/api/chaos/kill-network' are the correct endpoints.
    // The faultType string 'NETWORK_DROP' is NOT 'NETWORK_DROPOUT' — use the dedicated endpoint.
    try {
      if (faultType === 'CPU_SPIKE') {
        await fetch(`${GATEWAY_URL}/api/chaos/spike-cpu`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ region })
        });
      } else if (faultType === 'NETWORK_KILL') {
        await fetch(`${GATEWAY_URL}/api/chaos/kill-network`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ region })
        });
      }
    } catch (e) {
      console.error('Chaos injection failed', e);
    }
  };

  const handleCascade = async (scenario) => {
    try {
      await fetch(`${GATEWAY_URL}/api/chaos/cascade`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario })
      });
    } catch (e) {
      console.error('Cascade scenario failed', e);
    }
  };

  const handleReset = async () => {
    try {
      await fetch(`${GATEWAY_URL}/api/chaos/reset`, { method: 'POST' });
    } catch (e) {
      console.error('Reset failed', e);
    }
  };

  return (
    <div style={{
      position: 'absolute',
      bottom: '20px',
      left: '50%',
      transform: 'translateX(-50%)',
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
      padding: '20px',
      background: 'rgba(10, 10, 10, 0.82)',
      backdropFilter: 'blur(12px)',
      border: '1px solid rgba(0, 255, 65, 0.3)',
      borderRadius: '8px',
      boxShadow: '0 0 20px rgba(0, 255, 65, 0.1)',
      zIndex: 1000,
      maxWidth: 'calc(100vw - 380px)',
    }}>
      {/* Per-cluster controls */}
      <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap', justifyContent: 'center' }}>
        {clusters.map(cluster => (
          <div key={cluster.id} style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            borderRight: cluster.id !== 'apSouthCluster' ? '1px solid rgba(255,255,255,0.1)' : 'none',
            paddingRight: cluster.id !== 'apSouthCluster' ? '20px' : '0'
          }}>
            <h3 style={{
              color: '#00ff41', margin: '0 0 10px 0', fontFamily: 'monospace',
              fontSize: '13px', textShadow: '0 0 5px #00ff41', textAlign: 'center'
            }}>
              {cluster.label}
            </h3>
            <button onClick={() => handleInject(cluster.region, 'CPU_SPIKE')} style={btnStyle('#ff003c')}>
              Inject CPU Spike
            </button>
            <button onClick={() => handleInject(cluster.region, 'NETWORK_KILL')} style={btnStyle('#ffb000')}>
              Kill Network
            </button>
            <button onClick={() => onMitigate && onMitigate(cluster.id)} style={btnStyle('#00ff41')}>
              Force Mitigation
            </button>
          </div>
        ))}
      </div>

      {/* PWR-05: Cascade Scenarios + Reset row */}
      <div style={{ display: 'flex', gap: '10px', justifyContent: 'center', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '12px', flexWrap: 'wrap' }}>
        <span style={{ color: '#888', fontSize: '11px', fontFamily: 'monospace', alignSelf: 'center' }}>SCENARIOS:</span>
        {cascadeScenarios.map(s => (
          <button key={s.scenario} onClick={() => handleCascade(s.scenario)} style={btnStyle('#7b2fff')}>
            🌊 {s.label}
          </button>
        ))}
        <button onClick={handleReset} style={btnStyle('#00e5ff')}>
          ↺ Reset All
        </button>
      </div>
    </div>
  );
}

const btnStyle = (glowColor) => ({
  background: 'transparent',
  color: '#fff',
  border: `1px solid ${glowColor}`,
  padding: '8px 12px',
  borderRadius: '4px',
  fontFamily: 'monospace',
  fontSize: '12px',
  cursor: 'pointer',
  transition: 'all 0.2s ease',
  boxShadow: `0 0 5px ${glowColor}40`,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  whiteSpace: 'nowrap',
});
