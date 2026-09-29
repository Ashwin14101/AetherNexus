import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html, Edges } from '@react-three/drei';
import * as THREE from 'three';

// 1. Master Dimensions
const rackWidth = 1.5;
const rackHeight = 4.5;
const rackDepth = 1.5;

// 2. The Glass Casing Blueprint
const frameGeo = new THREE.BoxGeometry(rackWidth, rackHeight, rackDepth);

// 3. The Solid Server Slabs (10 thick blades with distinct gaps)
const numBlades = 10;
const bladeHeight = 0.25;
const bladeDepth = 1.3;
const bladeGeo = new THREE.BoxGeometry(rackWidth - 0.2, bladeHeight, bladeDepth);
const bladeMat = new THREE.MeshStandardMaterial({
  color: '#1a1a1a',
  metalness: 0.4,
  roughness: 0.9,
});

// 4. The Glowing Orbs (LEDs)
const ledsPerBlade = 4;
const totalLEDs = numBlades * ledsPerBlade;
const ledGeo = new THREE.SphereGeometry(0.035, 16, 16);
const ledMat = new THREE.MeshBasicMaterial({ color: '#ffffff' });

const sharedColor = new THREE.Color();

// BUG-A12 canonical colors
const STATUS_COLORS = {
  NOMINAL_GREEN: { base: new THREE.Color('#00ff41'), dim: new THREE.Color('#002200') },
  WARNING_AMBER: { base: new THREE.Color('#ffb000'), dim: new THREE.Color('#331a00') },
  CRITICAL_RED: { base: new THREE.Color('#ff003c'), dim: new THREE.Color('#220000') },
  HEALING: { base: new THREE.Color('#ffd700'), dim: new THREE.Color('#332200') },
};

export default function ServerRack({ position, label, status, healingProgress, metrics }) {
  const ledMeshRef = useRef();
  const currentColors = STATUS_COLORS[status] || STATUS_COLORS.NOMINAL_GREEN;

  // 5. The Mathematical Layout of the LEDs
  const ledData = useMemo(() => {
    const data = [];
    const spacing = rackHeight / numBlades;
    const startY = (rackHeight / 2) - (spacing / 2);
    for (let i = 0; i < numBlades; i++) {
      const y = startY - (i * spacing);
      for (let j = 0; j < ledsPerBlade; j++) {
        const x = -0.45 + (j * 0.3);
        const z = (bladeDepth / 2) + 0.015;
        const matrix = new THREE.Matrix4();
        matrix.setPosition(x, y, z);
        data.push({ matrix, blinkOffset: Math.random() * Math.PI * 2, blinkSpeed: 0.5 + Math.random() * 1.5 });
      }
    }
    return data;
  }, []);

  useFrame((state) => {
    if (!ledMeshRef.current) return;
    const time = state.clock.elapsedTime;
    const speedMultiplier = status === 'CRITICAL_RED' ? 6 : (status === 'WARNING_AMBER' ? 3 : (status === 'HEALING' ? 4 : 1));

    ledData.forEach((led, i) => {
      ledMeshRef.current.setMatrixAt(i, led.matrix);
      const blink = Math.sin(time * led.blinkSpeed * speedMultiplier + led.blinkOffset);
      sharedColor.copy(blink > 0 ? currentColors.base : currentColors.dim);
      ledMeshRef.current.setColorAt(i, sharedColor);
    });

    ledMeshRef.current.instanceMatrix.needsUpdate = true;
    if (ledMeshRef.current.instanceColor) ledMeshRef.current.instanceColor.needsUpdate = true;
  });

  // Derive live metrics for 3D label (IMP from AGENTS.md — render metrics prop)
  const cpu = metrics?.currentLoadPercentage ?? metrics?.computeLoadPercentage ?? null;
  const ram = metrics?.volatileMemoryAllocationGb
    ? metrics.volatileMemoryAllocationGb.toFixed(1)
    : metrics?.metrics?.ram ? (metrics.metrics.ram / 1024).toFixed(1) : null;
  const statusLabel = metrics?.status ?? metrics?.clusterOperationalStatus ?? status;

  return (
    <group position={position}>
      {/* The Glass Display Case */}
      <mesh geometry={frameGeo}>
        <meshStandardMaterial color="#000000" transparent opacity={0.15} depthWrite={false} />
        <Edges scale={1} threshold={15} color="#555555" />
      </mesh>

      {/* The Thick Solid Blades */}
      {Array.from({ length: numBlades }).map((_, i) => {
        const spacing = rackHeight / numBlades;
        const y = (rackHeight / 2) - (spacing / 2) - (i * spacing);
        return <mesh key={i} geometry={bladeGeo} material={bladeMat} position={[0, y, 0]} />;
      })}

      {/* The Glowing Orbs */}
      <instancedMesh ref={ledMeshRef} args={[ledGeo, ledMat, totalLEDs]}>
        <instancedBufferAttribute attach="instanceColor" args={[new Float32Array(totalLEDs * 3), 3]} />
      </instancedMesh>

      {/* Holographic Text Output — now includes live metrics (AGENTS.md requirement) */}
      <Html center position={[0, -3.2, 0]}>
        <div style={{
          color: currentColors.base.getStyle(),
          fontFamily: 'monospace',
          textShadow: `0 0 8px ${currentColors.base.getStyle()}`,
          fontWeight: 'bold',
          letterSpacing: '1px',
          whiteSpace: 'nowrap',
          textAlign: 'center',
          minWidth: '110px',
        }}>
          <div style={{ fontSize: '13px' }}>{label}</div>
          {/* Live metric labels from metrics prop */}
          {cpu !== null && (
            <div style={{ fontSize: '10px', marginTop: '3px', color: cpu > 90 ? '#ff003c' : cpu > 75 ? '#ffb000' : '#00ff41', opacity: 0.9 }}>
              CPU: {cpu.toFixed(1)}%
            </div>
          )}
          {ram !== null && (
            <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.6)', marginTop: '1px' }}>
              RAM: {ram}GB
            </div>
          )}
          {/* Healing progress bar */}
          {healingProgress !== undefined && healingProgress !== null && (
            <div style={{ marginTop: '5px', width: '100px', height: '8px', border: `1px solid ${currentColors.base.getStyle()}`, background: 'rgba(0,0,0,0.5)' }}>
              <div style={{ width: `${healingProgress}%`, height: '100%', background: currentColors.base.getStyle(), transition: 'width 0.3s ease' }} />
              <div style={{ fontSize: '9px', marginTop: '2px', color: '#ffd700' }}>HEAL: {healingProgress}%</div>
            </div>
          )}
        </div>
      </Html>
    </group>
  );
}