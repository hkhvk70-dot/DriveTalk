import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMobileMock } from '../src/mocks/mobileVehicle.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('public demonstration data is explicit, synthetic and has no owner location', () => {
  const value = createMobileMock();
  assert.equal(value.display_name, '示例车辆');
  assert.equal(value.charge_state?.battery_level, 80);
  assert.equal(value.vehicle_state?.odometer, 1000);
  assert.deepEqual([value.drive_state?.latitude, value.drive_state?.longitude], [0, 0]);
  assert.match(read('../.env.example'), /^VITE_DATA_MODE=mock$/m);
});

test('default 3D is locally generated geometry without external assets or action hotspots', () => {
  const model = read('../src/components/dashboard/VehicleModel.tsx');
  assert.match(model, /boxGeometry/);
  assert.match(model, /OrbitControls/);
  assert.doesNotMatch(model, /useGLTF|useLoader|cachedModelUrl|fetch\(|executeCommand|\.glb/);
  assert.match(read('../src/pages/HomePage.tsx'), /<VehicleModel \/>/);
});

test('native bridges remain TLS/origin restricted with a configurable deployment', () => {
  const source = read('../../mobile/src/main/java/org/drivetalk/app/MainActivity.java');
  assert.match(source, /BuildConfig\.HOME_URL/);
  assert.match(source, /sameOrigin\(uri\)/);
  assert.match(source, /handler\.cancel\(\)/);
  assert.match(source, /MIXED_CONTENT_NEVER_ALLOW/);
  assert.match(source, /getUserInfo\(\) == null/);
  assert.doesNotMatch(source, /handler\.proceed\(\)/);
  const pkg = JSON.parse(read('../package.json'));
  assert.equal(pkg.private, true);
  assert.equal(pkg.dependencies['react-leaflet'], undefined);
  assert.equal(pkg.dependencies.leaflet, undefined);
});
