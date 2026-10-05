import { OrbitControls } from '@react-three/drei';
import { Canvas, useFrame } from '@react-three/fiber';
import { Component, useRef, type ReactNode } from 'react';
import { MathUtils, type Group } from 'three';
import { useVehicleStore } from '../../stores/mobileVehicleStore';
import VehicleVisualizer from './VehicleVisualizer';

// 原创通用几何车辆：不下载模型、贴图、字体或厂商资源，也没有真实控车热点。
type DoorKey = 'df' | 'pf' | 'dr' | 'pr';
const open = (value: number | null | undefined) => typeof value === 'number' && value > 0;

function Door({ side, startZ, opened }: { side: -1 | 1; startZ: number; opened: boolean }) {
  const hinge = useRef<Group>(null);
  useFrame((_, delta) => {
    if (hinge.current) hinge.current.rotation.y = MathUtils.damp(hinge.current.rotation.y, opened ? side * -1.05 : 0, 8, delta);
  });
  return <group ref={hinge} position={[side * 0.86, 0.88, startZ]}>
    <mesh position={[0, 0, 0.48]} castShadow><boxGeometry args={[0.055, 0.68, 0.93]} /><meshStandardMaterial color="#8aa4bc" metalness={0.55} roughness={0.3} /></mesh>
    <mesh position={[0, 0.52, 0.45]}><boxGeometry args={[0.035, 0.39, 0.86]} /><meshStandardMaterial color="#172735" roughness={0.25} metalness={0.25} /></mesh>
    <mesh position={[side * 0.045, 0.16, 0.68]}><boxGeometry args={[0.04, 0.045, 0.2]} /><meshStandardMaterial color="#e2e8f0" metalness={0.7} roughness={0.25} /></mesh>
  </group>;
}

function Lid({ rear, opened }: { rear: boolean; opened: boolean }) {
  const hinge = useRef<Group>(null);
  useFrame((_, delta) => {
    if (hinge.current) hinge.current.rotation.x = MathUtils.damp(hinge.current.rotation.x, opened ? (rear ? -1.15 : 0.95) : 0, 8, delta);
  });
  return <group ref={hinge} position={[0, 1.01, rear ? 0.97 : -0.99]}>
    <mesh position={[0, 0, rear ? 0.4 : -0.45]} castShadow><boxGeometry args={[1.57, 0.1, rear ? 0.78 : 0.88]} /><meshStandardMaterial color="#8aa4bc" metalness={0.55} roughness={0.3} /></mesh>
  </group>;
}

function VehicleGeometry() {
  const state = useVehicleStore(s => s.vehicleData?.vehicle_state);
  const portOpen = useVehicleStore(s => s.vehicleData?.charge_state?.charge_port_door_open === true);
  const portHinge = useRef<Group>(null);
  useFrame((_, delta) => {
    if (portHinge.current) portHinge.current.rotation.y = MathUtils.damp(portHinge.current.rotation.y, portOpen ? -1.15 : 0, 8, delta);
  });
  const doors: { key: DoorKey; side: -1 | 1; startZ: number }[] = [
    { key: 'df', side: -1, startZ: -1 }, { key: 'pf', side: 1, startZ: -1 },
    { key: 'dr', side: -1, startZ: 0 }, { key: 'pr', side: 1, startZ: 0 },
  ];
  return <group position={[0, -0.52, 0]}>
    <mesh position={[0, 0.55, 0]} castShadow><boxGeometry args={[1.62, 0.5, 3.65]} /><meshStandardMaterial color="#8aa4bc" metalness={0.55} roughness={0.3} /></mesh>
    <mesh position={[0, 0.98, 0]}><boxGeometry args={[1.48, 0.38, 1.94]} /><meshStandardMaterial color="#182029" roughness={0.8} /></mesh>
    <mesh position={[0, 1.64, 0]} castShadow><boxGeometry args={[1.48, 0.1, 1.4]} /><meshStandardMaterial color="#263747" roughness={0.3} metalness={0.4} /></mesh>
    <mesh position={[0, 1.4, -0.84]} rotation={[-0.48, 0, 0]}><boxGeometry args={[1.48, 0.47, 0.04]} /><meshStandardMaterial color="#172735" metalness={0.25} roughness={0.25} /></mesh>
    <mesh position={[0, 1.4, 0.84]} rotation={[0.48, 0, 0]}><boxGeometry args={[1.48, 0.47, 0.04]} /><meshStandardMaterial color="#172735" metalness={0.25} roughness={0.25} /></mesh>
    {doors.map(door => <Door key={door.key} side={door.side} startZ={door.startZ} opened={open(state?.[door.key])} />)}
    <Lid rear={false} opened={open(state?.ft)} /><Lid rear opened={open(state?.rt)} />
    {([-1, 1] as const).flatMap(side => [-1.23, 1.23].map(z => <group key={`${side}:${z}`} position={[side * 0.82, 0.4, z]} rotation={[0, 0, Math.PI / 2]}>
      <mesh castShadow><cylinderGeometry args={[0.36, 0.36, 0.25, 24]} /><meshStandardMaterial color="#11151b" roughness={0.85} /></mesh>
      <mesh><cylinderGeometry args={[0.22, 0.22, 0.26, 12]} /><meshStandardMaterial color="#b0bac5" metalness={0.8} roughness={0.25} /></mesh>
    </group>))}
    {[-1, 1].map(side => <group key={side}>
      <mesh position={[side * 0.53, 0.8, -1.85]}><boxGeometry args={[0.45, 0.13, 0.025]} /><meshStandardMaterial color="#d8ecff" emissive="#b6d8ef" emissiveIntensity={0.25} /></mesh>
      <mesh position={[side * 0.53, 0.8, 1.85]}><boxGeometry args={[0.45, 0.1, 0.025]} /><meshStandardMaterial color="#ad3939" /></mesh>
    </group>)}
    <group ref={portHinge} position={[-0.83, 0.89, 1.12]}><mesh position={[0, 0, 0.1]}><boxGeometry args={[0.04, 0.19, 0.22]} /><meshStandardMaterial color={portOpen ? '#7de0b2' : '#8aa4bc'} /></mesh></group>
  </group>;
}

class ModelErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

export default function VehicleModel() {
  const state = useVehicleStore(s => s.vehicleData?.vehicle_state);
  return <ModelErrorBoundary fallback={<VehicleVisualizer state={state} />}>
    <section aria-label="通用三维车辆状态示意" className="relative h-[300px] overflow-hidden rounded-2xl bg-[#171a20] sm:h-[380px]">
      <Canvas shadows dpr={[1, 1.5]} camera={{ position: [4.5, 3.2, -5.8], fov: 36, near: 0.1, far: 40 }} gl={{ antialias: true }}>
        <color attach="background" args={['#171a20']} />
        <ambientLight intensity={1.1} /><hemisphereLight args={['#d7eaff', '#2d343e', 1.2]} />
        <directionalLight castShadow position={[4, 7, -3]} intensity={2.5} shadow-mapSize-width={512} shadow-mapSize-height={512} />
        <directionalLight position={[-4, 3, 4]} intensity={1.1} />
        <VehicleGeometry />
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.51, 0]} receiveShadow><planeGeometry args={[20, 20]} /><shadowMaterial transparent opacity={0.18} /></mesh>
        <OrbitControls enablePan={false} enableDamping minDistance={4.5} maxDistance={9} minPolarAngle={0.35} maxPolarAngle={1.45} target={[0, 0.4, 0]} />
      </Canvas>
      <p className="pointer-events-none absolute bottom-2 left-2 right-2 text-center text-[10px] text-neutral-500">原创通用示意 · 拖动旋转 · 仅显示最近快照，未知状态不代表关闭</p>
    </section>
  </ModelErrorBoundary>;
}
