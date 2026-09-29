import { useRef, useMemo, useEffect, useState, useCallback } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Html } from '@react-three/drei';
import * as THREE from 'three';
import { io } from 'socket.io-client';
import ServerRack from './components/ServerRack';
import Diagnostics from './components/Diagnostics';
import DevOpsControls from './components/DevOpsControls';
import './App.css';

const GATEWAY_URL = import.meta.env.VITE_API_GATEWAY_URL || 'http://localhost:4000';

const packetGeo = new THREE.BoxGeometry(0.1, 0.1, 0.1);
const packetMat = new THREE.MeshBasicMaterial({ color: '#ffffff' });

const gatewayGeo = new THREE.BoxGeometry(3, 0.5, 2);
const rackMat = new THREE.MeshStandardMaterial({
  color: '#2a2e39',
  metalness: 0.8,
  roughness: 0.2,
  transparent: true,
  opacity: 0.9,
});

const wireframeGeo = new THREE.BoxGeometry(3.1, 0.6, 2.1);

function ApiGateway({ position }) {
  return (
    <group position={position}>
      <mesh geometry={gatewayGeo} material={rackMat} />
      <mesh geometry={wireframeGeo}>
        <meshBasicMaterial color="#00e5ff" wireframe transparent opacity={0.5} />
      </mesh>
      <Html center position={[0, 1, 0]}>
        <div style={{ color: '#00e5ff', fontFamily: 'monospace', textShadow: `0 0 5px #00e5ff`, fontWeight: 'bold' }}>
          API GATEWAY
        </div>
      </Html>
    </group>
  );
}

function DataFlowSystem({ apiGatewayPos, racks, statuses, trafficWeights }) {
  const meshRef = useRef();

  const packets = useMemo(() => {
    const arr = [];
    racks.forEach((rack, rackIdx) => {
      for (let i = 0; i < 150; i++) {
        arr.push({
          rackIdx,
          progress: Math.random(),
          speed: 0.2 + Math.random() * 0.3
        });
      }
    });
    return arr;
  }, [racks]);

  const dummy = useMemo(() => new THREE.Object3D(), []);
  const colorObj = useMemo(() => new THREE.Color(), []);
  const gatewayVec = useMemo(() => new THREE.Vector3(...apiGatewayPos), [apiGatewayPos]);
  const rackVecs = useMemo(() => racks.map(r => new THREE.Vector3(...r.position)), [racks]);

  useFrame((state, delta) => {
    if (!meshRef.current) return;

    const weights = [
      trafficWeights?.usEastCluster || 0,
      trafficWeights?.euWestCluster || 0,
      trafficWeights?.apSouthCluster || 0
    ];
    const sum = weights.reduce((a, b) => a + b, 0);
    const normalizedWeights = sum > 0 ? weights.map(w => w / sum) : [0, 0, 0];

    packets.forEach((p, i) => {
      p.progress += delta * p.speed;
      if (p.progress > 1) {
        p.progress = 0;

        if (sum > 0) {
          const rand = Math.random();
          let runningTotal = 0;
          p.rackIdx = 0;
          for (let idx = 0; idx < normalizedWeights.length; idx++) {
            runningTotal += normalizedWeights[idx];
            if (rand < runningTotal) {
              p.rackIdx = idx;
              break;
            }
          }
        }
      }

      const targetRack = racks[p.rackIdx];

      dummy.position.lerpVectors(
        gatewayVec,
        rackVecs[p.rackIdx],
        p.progress
      );
      dummy.updateMatrix();
      meshRef.current.setMatrixAt(i, dummy.matrix);

      const status = statuses[targetRack.id] || 'NOMINAL_GREEN';
      if (status === 'CRITICAL_RED') colorObj.set('#ff3333');
      else if (status === 'WARNING_AMBER') colorObj.set('#ffaa00');
      else if (status === 'HEALING') colorObj.set('#ffd700');
      else colorObj.set('#00ff41');  // BUG-A12 FIX: was #00ff00

      meshRef.current.setColorAt(i, colorObj);
    });

    meshRef.current.instanceMatrix.needsUpdate = true;
    if (meshRef.current.instanceColor) meshRef.current.instanceColor.needsUpdate = true;
  });

  return (
    <instancedMesh ref={meshRef} args={[packetGeo, packetMat, packets.length]}>
      <instancedBufferAttribute attach="instanceColor" args={[new Float32Array(packets.length * 3), 3]} />
    </instancedMesh>
  );
}

export default function App() {
  // BUG-A11 FIX: Removed debug console.log from render body (leaked env var in prod)
  const [currentView, setCurrentView] = useState('topology');
  const [logs, setLogs] = useState([]);
  const [trafficWeights, setTrafficWeights] = useState({ usEastCluster: 33.3, euWestCluster: 33.3, apSouthCluster: 33.4 });
  const [statuses, setStatuses] = useState({
    usEastCluster: 'NOMINAL_GREEN',
    euWestCluster: 'NOMINAL_GREEN',
    apSouthCluster: 'NOMINAL_GREEN'
  });
  const [healingProgresses, setHealingProgresses] = useState({});
  const [liveMetrics, setLiveMetrics] = useState({});
  // PWR-03: Track system paused state from AI broadcasts
  const [isSystemPaused, setIsSystemPaused] = useState(false);
  const [pauseCountdown, setPauseCountdown] = useState(null);

  const mitigationIntervals = useRef({});

  useEffect(() => {
    return () => {
      Object.values(mitigationIntervals.current).forEach(clearInterval);
    };
  }, []);

  const apiGatewayPos = useMemo(() => [0, 6, 0], []);
  const racks = useMemo(() => [
    { id: 'usEastCluster', position: [-6, -2, 0], label: 'US-EAST' },
    { id: 'euWestCluster', position: [0, -2, 0], label: 'EU-WEST' },
    { id: 'apSouthCluster', position: [6, -2, 0], label: 'AP-SOUTH' }
  ], []);

  useEffect(() => {
    const socket = io(GATEWAY_URL);
    const onConnect = () => {
      fetch(`${GATEWAY_URL}/api/telemetry`)
        .then(res => res.json())
        .then(data => {
          if (data && data.infrastructureState) {
            setLiveMetrics(data.infrastructureState);
            Object.entries(data.infrastructureState).forEach(([regionId, metrics]) => {
              const cpu = metrics?.currentLoadPercentage ?? metrics?.computeLoadPercentage ?? 0;
              const dbStatus = metrics?.status ?? metrics?.clusterOperationalStatus;
              if (dbStatus === 'HEALING') setStatuses(prev => ({ ...prev, [regionId]: 'HEALING' }));
              else if (dbStatus === 'CRITICAL_NETWORK_DOWN' || dbStatus === 'CRITICAL') setStatuses(prev => ({ ...prev, [regionId]: 'CRITICAL_RED' }));
              else if (cpu > 90) setStatuses(prev => ({ ...prev, [regionId]: 'CRITICAL_RED' }));
              else if (cpu > 75) setStatuses(prev => ({ ...prev, [regionId]: 'WARNING_AMBER' }));
              else setStatuses(prev => ({ ...prev, [regionId]: 'NOMINAL_GREEN' }));
            });
            if (data.isSystemPaused) {
              setIsSystemPaused(true);
              setPauseCountdown(300);
            }
          }
        }).catch(err => console.error('Reconnect fetch failed', err));
    };
    socket.on('connect', onConnect);

    socket.on('aethernexus-telemetry-broadcast', (data) => {
      setLogs(prev => [data, ...prev].slice(0, 100));
      if (data.trafficDistribution) setTrafficWeights(data.trafficDistribution);
      // PWR-03: Detect system paused state from broadcast
      if (data.incidentThreatLevelColor === 'CRITICAL_RED' && data.executedMitigationAction?.includes('Human override')) {
        setIsSystemPaused(true);
        setPauseCountdown(300);
      }
      if (data.incidentThreatLevelColor === 'NOMINAL_GREEN') setIsSystemPaused(false);
      if (data.targetClusterRegion && data.incidentThreatLevelColor) {
        setStatuses(prev => ({ ...prev, [data.targetClusterRegion]: data.incidentThreatLevelColor }));
        if (data.healingProgress !== undefined) setHealingProgresses(prev => ({ ...prev, [data.targetClusterRegion]: data.healingProgress }));
      }
    });

    socket.on('live-metrics-stream', (data) => {
      setLiveMetrics(data);

      Object.entries(data).forEach(([regionId, metrics]) => {
        const m = metrics;
        const cpu = m?.currentLoadPercentage ?? m?.computeLoadPercentage ?? 0;
        const dbStatus = m?.status ?? m?.clusterOperationalStatus;
        if (dbStatus === 'HEALING') {
          setStatuses(prev => ({ ...prev, [regionId]: 'HEALING' }));
        } else if (dbStatus === 'CRITICAL_NETWORK_DOWN' || dbStatus === 'CRITICAL') {
          setStatuses(prev => ({ ...prev, [regionId]: 'CRITICAL_RED' }));
        } else if (cpu > 90) {
          setStatuses(prev => ({ ...prev, [regionId]: 'CRITICAL_RED' }));
        } else if (cpu > 75) {
          setStatuses(prev => ({ ...prev, [regionId]: 'WARNING_AMBER' }));
        } else {
          setStatuses(prev => ({ ...prev, [regionId]: 'NOMINAL_GREEN' }));
        }

        const ram = m?.metrics?.ram ? (m.metrics.ram / 1024) : (m?.volatileMemoryAllocationGb || 0);
        const logEntry = `[${new Date().toLocaleTimeString()}] ${regionId.toUpperCase()} | CPU: ${cpu.toFixed(1)}% | RAM: ${ram.toFixed(1)}GB | Status: ${dbStatus}`;
        setLogs(prev => [logEntry, ...prev].slice(0, 100));
      });
    });

    // AI Orchestrator real-time insight stream
    socket.on('ai-log', (data) => {
      const formattedLog = `[AI - ${data.level ? data.level.toUpperCase() : 'INFO'}] ${data.text}`;
      setLogs(prev => [formattedLog, ...prev].slice(0, 100));
    });

    // GAP-011 FIX: handle three canonical WebSocket event types from spec
    // AE_NODE_ISOLATION — node quarantined; update statuses and traffic weights
    socket.on('AE_NODE_ISOLATION', (data) => {
      if (data.nodes && Array.isArray(data.nodes)) {
        setStatuses(prev => {
          const next = { ...prev };
          data.nodes.forEach(n => { if (n.id) next[n.id] = n.colorCode || 'CRITICAL_RED'; });
          return next;
        });
        setTrafficWeights(prev => {
          const next = { ...prev };
          data.nodes.forEach(n => { if (n.id && n.load !== undefined) next[n.id] = n.load; });
          return next;
        });
        const isolationLog = { eventTimestamp: new Date().toISOString(), principalArchitect: 'AetherNexus-Core', executedMitigationAction: `Node isolation triggered for: ${data.nodes.map(n => n.id).join(', ')}`, incidentThreatLevelColor: 'CRITICAL_RED' };
        setLogs(prev => [isolationLog, ...prev].slice(0, 100));
      }
    });

    // AE_NODE_HEALING — mitigation started; set target node to HEALING state
    socket.on('AE_NODE_HEALING', (data) => {
      if (data.targetNode) {
        setStatuses(prev => ({ ...prev, [data.targetNode]: 'HEALING' }));
        setHealingProgresses(prev => ({ ...prev, [data.targetNode]: 0 }));
        const healingLog = { eventTimestamp: new Date().toISOString(), principalArchitect: 'AetherNexus-Core', executedMitigationAction: `Healing initiated on ${data.targetNode}`, incidentThreatLevelColor: 'HEALING' };
        setLogs(prev => [healingLog, ...prev].slice(0, 100));
      }
    });

    // AE_NETWORK_RESTORED — all nodes healthy; restore statuses and traffic weights
    socket.on('AE_NETWORK_RESTORED', (data) => {
      if (data.nodes && Array.isArray(data.nodes)) {
        setStatuses(prev => {
          const next = { ...prev };
          data.nodes.forEach(n => { if (n.id) next[n.id] = n.colorCode || 'NOMINAL_GREEN'; });
          return next;
        });
        setTrafficWeights(prev => {
          const next = { ...prev };
          data.nodes.forEach(n => { if (n.id && n.load !== undefined) next[n.id] = n.load; });
          return next;
        });
        setHealingProgresses(prev => {
          const next = { ...prev };
          data.nodes.forEach(n => { if (n.id) next[n.id] = null; });
          return next;
        });
        const restoredLog = { eventTimestamp: new Date().toISOString(), principalArchitect: 'AetherNexus-Core', executedMitigationAction: `Network restored. All nodes nominal.`, incidentThreatLevelColor: 'NOMINAL_GREEN' };
        setLogs(prev => [restoredLog, ...prev].slice(0, 100));
      }
    });

    return () => {
      // BUG-A18 FIX: Remove ALL registered listeners including 'connect'
      socket.off('connect', onConnect);
      socket.off('aethernexus-telemetry-broadcast');
      socket.off('live-metrics-stream');
      socket.off('ai-log');
      socket.off('AE_NODE_ISOLATION');
      socket.off('AE_NODE_HEALING');
      socket.off('AE_NETWORK_RESTORED');
      socket.disconnect();
    };
  }, []);

  // IMP-17: useCallback to prevent DevOpsControls re-render on every state change
  const handleManualMitigate = useCallback(async (region) => {
    try {
      const res = await fetch(`${GATEWAY_URL}/api/mitigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetClusterRegion: region, cacheLayerNamespace: 'manual-ui-override' })
      });
      const data = await res.json();
      if (!data.success) throw new Error('Mitigation failed on backend');
      setStatuses(prev => ({ ...prev, [region]: 'HEALING' }));
      setHealingProgresses(prev => ({ ...prev, [region]: 0 }));
      let progress = 0;
      if (mitigationIntervals.current[region]) clearInterval(mitigationIntervals.current[region]);
      mitigationIntervals.current[region] = setInterval(() => {
        progress += 1;
        if (progress >= 100) {
          clearInterval(mitigationIntervals.current[region]);
          setStatuses(prev => ({ ...prev, [region]: 'NOMINAL_GREEN' }));
          setHealingProgresses(prev => ({ ...prev, [region]: null }));
        } else {
          setHealingProgresses(prev => ({ ...prev, [region]: progress }));
        }
      }, 300);
    } catch (e) {
      console.error('Manual mitigation failed', e);
      setStatuses(prev => ({ ...prev, [region]: 'CRITICAL_RED' }));
    }
  }, []);

  // BUG-A12 FIX: Use canonical color constants from AGENTS.md / skills.md
  const colorMap = {
    NOMINAL_GREEN: '#00ff41',  // was #00ff00
    WARNING_AMBER: '#ffb000',
    CRITICAL_RED: '#ff003c',
    HEALING: '#ffd700',
  };

  // PWR-10: Export logs as JSON file
  const handleExportLogs = () => {
    const blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `aethernexus-logs-${new Date().toISOString().replace(/:/g, '-').slice(0, 19)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // PWR-03: Resume AI system
  const handleResumeSystem = async () => {
    try {
      await fetch(`${GATEWAY_URL}/api/system/resume`, { method: 'POST' });
      setIsSystemPaused(false);
      setPauseCountdown(null);
    } catch (e) {
      console.error('Resume failed', e);
    }
  };

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#0a0a0a', overflow: 'hidden', position: 'relative' }}>
      {currentView === 'diagnostics' ? (
        <Diagnostics onReturn={() => setCurrentView('topology')} logs={logs} statuses={statuses} trafficWeights={trafficWeights} />
      ) : (
        <>
          <Canvas camera={{ position: [0, 4, 15], fov: 50 }}>
            <ambientLight intensity={0.5} />
            <pointLight position={[0, 10, 0]} intensity={1.5} color="#ffffff" />

            <ApiGateway position={apiGatewayPos} />

            {racks.map(rack => (
              <ServerRack
                key={rack.id}
                position={rack.position}
                label={rack.label}
                status={statuses[rack.id]}
                healingProgress={healingProgresses[rack.id]}
                metrics={liveMetrics[rack.id]}
              />
            ))}

            <DataFlowSystem apiGatewayPos={apiGatewayPos} racks={racks} statuses={statuses} trafficWeights={trafficWeights} />

            <OrbitControls enablePan={true} maxPolarAngle={Math.PI / 2} minPolarAngle={Math.PI / 6} />
          </Canvas>

          {/* Glassmorphism Sidebar */}
          <div style={{
            position: 'absolute',
            top: 20,
            right: 20,
            width: 320,
            height: 'calc(100% - 40px)',
            background: 'rgba(20, 20, 25, 0.65)',
            backdropFilter: 'blur(12px)',
            border: '1px solid #00e5ff',
            borderRadius: 8,
            padding: 20,
            color: '#fff',
            fontFamily: 'monospace',
            overflowY: 'hidden',
            boxShadow: '0 0 20px rgba(0, 229, 255, 0.15)',
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: 'column'
          }}>
            <div style={{ position: 'absolute', top: 15, right: 15, fontSize: 11, color: '#00e5ff', opacity: 0.8 }}>
              Session: Admin
            </div>
            <h3 style={{ borderBottom: '1px solid rgba(0, 229, 255, 0.3)', paddingBottom: 15, marginTop: 0, letterSpacing: '2px' }}>TELEMETRY LOGS</h3>

            {/* PWR-03: System Paused Banner */}
            {isSystemPaused && (
              <div style={{ marginBottom: 10, padding: '10px', background: 'rgba(255,0,60,0.15)', border: '1px solid #ff003c', borderRadius: 4, color: '#ff003c', fontSize: 11, fontFamily: 'monospace' }}>
                ⚠ AI PAUSED — Human Override Pending
                <button onClick={handleResumeSystem} style={{ display: 'block', marginTop: 6, width: '100%', padding: '6px', background: '#ff003c', border: 'none', color: '#fff', fontFamily: 'monospace', cursor: 'pointer', borderRadius: 3, fontWeight: 'bold' }}>
                  [ RESUME AI ]
                </button>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', flexGrow: 1, overflowY: 'auto' }}>
              {logs.map((log, i) => {
                const AI_LEVEL_COLORS = { info: '#00e5ff', warning: '#ffaa00', critical: '#ff3333', success: '#00ff41' };
                const isAiLog = log?.text !== undefined && log?.level !== undefined;
                const isString = typeof log === 'string';

                let borderColor = '#00ff41';
                let textColor = '#00ff41';
                if (isString) {
                  if (log.includes('CRITICAL')) {
                    borderColor = '#ff4444';
                    textColor = '#ff4444';
                  } else if (log.includes('WARNING')) {
                    borderColor = '#ffcc00';
                    textColor = '#ffcc00';
                  }
                } else if (isAiLog) {
                  borderColor = AI_LEVEL_COLORS[log.level] || '#00e5ff';
                } else {
                  borderColor = colorMap[log.incidentThreatLevelColor] || '#00ff00';
                }

                return (
                  <div key={i} style={{ fontSize: 12, padding: '8px', background: 'rgba(0,0,0,0.3)', borderRadius: '4px', borderLeft: `3px solid ${borderColor}` }}>
                    {isAiLog ? (
                      <>
                        <div style={{ color: AI_LEVEL_COLORS[log.level] || '#00e5ff', marginBottom: '3px', fontSize: '10px', fontFamily: 'monospace' }}>
                          {`[${new Date(log.timestamp).toLocaleTimeString()}] <${log.architect}> [${log.level?.toUpperCase()}]`}
                        </div>
                        <div style={{ color: '#e0e0e0', lineHeight: '1.4' }}>{log.text}</div>
                      </>
                    ) : isString ? (
                      <div style={{ color: textColor, lineHeight: '1.4', fontFamily: 'monospace' }}>{log}</div>
                    ) : (
                      <>
                        <div style={{ color: colorMap[log.incidentThreatLevelColor] || '#00ff00', marginBottom: '4px', fontSize: '10px' }}>
                          [{new Date(log.eventTimestamp).toLocaleTimeString()}] &lt;{log.principalArchitect}&gt;
                        </div>
                        <div style={{ color: '#e0e0e0', lineHeight: '1.4' }}>
                          {log.executedMitigationAction}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
              {logs.length === 0 && (
                <div style={{ color: '#666', fontStyle: 'italic', marginTop: '20px', textAlign: 'center' }}>Awaiting telemetry streams...</div>
              )}
            </div>

            <button
              onClick={() => setCurrentView('diagnostics')}
              style={{
                marginTop: '20px',
                width: '100%',
                padding: '12px',
                background: 'transparent',
                border: '1px solid #00e5ff',
                color: '#00e5ff',
                fontFamily: 'monospace',
                cursor: 'pointer',
                borderRadius: '4px',
                boxShadow: '0 0 10px rgba(0, 229, 255, 0.2)',
                fontWeight: 'bold',
                letterSpacing: '1px',
                transition: 'all 0.3s ease'
              }}
              onMouseOver={(e) => { e.target.style.background = 'rgba(0, 229, 255, 0.1)'; e.target.style.boxShadow = '0 0 15px rgba(0, 229, 255, 0.4)'; }}
              onMouseOut={(e) => { e.target.style.background = 'transparent'; e.target.style.boxShadow = '0 0 10px rgba(0, 229, 255, 0.2)'; }}
            >
              [ LAUNCH DIAGNOSTICS ]
            </button>
            {/* PWR-10: Export logs button */}
            <button
              onClick={handleExportLogs}
              style={{ marginTop: '8px', width: '100%', padding: '10px', background: 'transparent', border: '1px solid rgba(0,229,255,0.4)', color: 'rgba(0,229,255,0.7)', fontFamily: 'monospace', cursor: 'pointer', borderRadius: '4px', fontWeight: 'bold', letterSpacing: '1px', fontSize: '11px', transition: 'all 0.3s ease' }}
              onMouseOver={(e) => { e.target.style.background = 'rgba(0,229,255,0.07)'; }}
              onMouseOut={(e) => { e.target.style.background = 'transparent'; }}
            >
              [ EXPORT LOGS ]
            </button>
          </div>
        </>
      )}
      {currentView !== 'diagnostics' && (
        <DevOpsControls onMitigate={handleManualMitigate} />
      )}
    </div>
  );
}
