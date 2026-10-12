import { useState } from 'react';
import { API_BASE as GATEWAY_URL } from '../config';

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

export default function DevOpsControls({ onMitigate, onReset, onSelectCluster }) {
  // Track active actions for visual feedback
  const [activeActions, setActiveActions] = useState({});

  const setActionActive = (key, isActive) => {
    setActiveActions(prev => ({ ...prev, [key]: isActive }));
    if (isActive) {
      // Auto-clear the active state after 3 seconds
      setTimeout(() => setActiveActions(prev => ({ ...prev, [key]: false })), 3000);
    }
  };

  const handleInject = async (region, faultType) => {
    const actionKey = `${region}-${faultType}`;
    setActionActive(actionKey, true);
    try {
      if (faultType === 'CPU_SPIKE') {
        const res = await fetch(`${GATEWAY_URL}/api/chaos/spike-cpu`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ region })
        });
        const data = await res.json();
        console.log(`[Chaos] CPU Spike injected:`, data);
      } else if (faultType === 'NETWORK_KILL') {
        const res = await fetch(`${GATEWAY_URL}/api/chaos/kill-network`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ region })
        });
        const data = await res.json();
        console.log(`[Chaos] Network killed:`, data);
      }
    } catch (e) {
      console.error('Chaos injection failed:', e);
      setActionActive(actionKey, false);
    }
  };

  const handleCascade = async (scenario) => {
    const actionKey = `cascade-${scenario}`;
    setActionActive(actionKey, true);
    try {
      const res = await fetch(`${GATEWAY_URL}/api/chaos/cascade`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario })
      });
      const data = await res.json();
      console.log(`[Chaos] Cascade scenario "${scenario}" started:`, data);
    } catch (e) {
      console.error('Cascade scenario failed:', e);
      setActionActive(actionKey, false);
    }
  };

  const handleReset = async () => {
    setActionActive('reset', true);
    if (onReset) onReset();
    try {
      const res = await fetch(`${GATEWAY_URL}/api/chaos/reset`, { method: 'POST' });
      const data = await res.json();
      console.log(`[Chaos] Reset:`, data);
    } catch (e) {
      console.error('Reset failed:', e);
    }
  };

  const getBtnStyle = (glowColor, actionKey) => {
    const isActive = activeActions[actionKey];
    return {
      background: isActive ? `${glowColor}25` : 'transparent',
      color: isActive ? glowColor : '#fff',
      border: `1px solid ${glowColor}`,
      padding: '8px 12px',
      borderRadius: '4px',
      fontFamily: 'monospace',
      fontSize: '12px',
      cursor: 'pointer',
      transition: 'all 0.2s ease',
      boxShadow: isActive ? `0 0 15px ${glowColor}60` : `0 0 5px ${glowColor}40`,
      textTransform: 'uppercase',
      letterSpacing: '0.05em',
      whiteSpace: 'nowrap',
      transform: isActive ? 'scale(0.97)' : 'scale(1)',
    };
  };

  return (
    <div className="devops-controls" style={{
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
            <button
              onClick={() => onSelectCluster?.(cluster.id)}
              style={{ background: 'transparent', border: 0, cursor: 'pointer', padding: 0 }}
            >
            <h3 style={{
              color: '#00ff41', margin: '0 0 10px 0', fontFamily: 'monospace',
              fontSize: '13px', textShadow: '0 0 5px #00ff41', textAlign: 'center'
            }}>
              {cluster.label}
            </h3>
            </button>
            <button
              onClick={() => handleInject(cluster.region, 'CPU_SPIKE')}
              style={getBtnStyle('#ff003c', `${cluster.region}-CPU_SPIKE`)}
            >
              {activeActions[`${cluster.region}-CPU_SPIKE`] ? '⚡ Injecting...' : 'Inject CPU Spike'}
            </button>
            <button
              onClick={() => handleInject(cluster.region, 'NETWORK_KILL')}
              style={getBtnStyle('#ffb000', `${cluster.region}-NETWORK_KILL`)}
            >
              {activeActions[`${cluster.region}-NETWORK_KILL`] ? '🔌 Killing...' : 'Kill Network'}
            </button>
            <button
              onClick={() => onMitigate && onMitigate(cluster.id)}
              style={getBtnStyle('#00ff41', `mitigate-${cluster.id}`)}
            >
              Force Mitigation
            </button>
          </div>
        ))}
      </div>

      {/* PWR-05: Cascade Scenarios + Reset row */}
      <div style={{ display: 'flex', gap: '10px', justifyContent: 'center', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '12px', flexWrap: 'wrap' }}>
        <span style={{ color: '#888', fontSize: '11px', fontFamily: 'monospace', alignSelf: 'center' }}>SCENARIOS:</span>
        {cascadeScenarios.map(s => (
          <button
            key={s.scenario}
            onClick={() => handleCascade(s.scenario)}
            style={getBtnStyle('#7b2fff', `cascade-${s.scenario}`)}
          >
            {activeActions[`cascade-${s.scenario}`] ? '🌊 Running...' : `🌊 ${s.label}`}
          </button>
        ))}
        <button
          onClick={handleReset}
          style={getBtnStyle('#00e5ff', 'reset')}
        >
          {activeActions['reset'] ? '↺ Resetting...' : '↺ Reset All'}
        </button>
      </div>
    </div>
  );
}
