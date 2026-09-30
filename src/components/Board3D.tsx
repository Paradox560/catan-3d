import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { BuildKind, GameState, Terrain } from '../game/types';

type Props = {
  state: GameState;
  buildKind: BuildKind | null;
  legalIds: number[];
  onVertex: (id: number) => void;
  onEdge: (id: number) => void;
  onHex: (id: number) => void;
  interactive: boolean;
  resetView?: number;
};
type Hit = { kind: 'vertex' | 'edge' | 'hex'; id: number; label: string; actionable: boolean };
type Hover = { label: string; x: number; y: number } | null;
const TERRAIN: Record<Terrain, { top: string; side: string; label: string }> = {
  wood: { top: '#3e8562', side: '#35674f', label: 'Forest · Lumber' },
  brick: { top: '#c87953', side: '#95523f', label: 'Hills · Brick' },
  sheep: { top: '#8cb96a', side: '#648453', label: 'Pasture · Wool' },
  wheat: { top: '#d8bb68', side: '#aa8844', label: 'Fields · Grain' },
  ore: { top: '#9eaaa5', side: '#697976', label: 'Mountains · Ore' },
  desert: { top: '#dfc38b', side: '#b69963', label: 'Desert' },
};
const RES_NAMES: Record<string, string> = {
  wood: 'Lumber',
  brick: 'Brick',
  sheep: 'Wool',
  wheat: 'Grain',
  ore: 'Ore',
  any: 'Any resource',
};

function rng(seed: number) {
  let n = seed >>> 0;
  return () => {
    n = (Math.imul(1664525, n) + 1013904223) >>> 0;
    return n / 4294967296;
  };
}
function material(
  color: THREE.ColorRepresentation,
  opts: THREE.MeshStandardMaterialParameters = {},
) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.92, flatShading: true, ...opts });
}
function solid(
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  mat: THREE.Material,
  x: number,
  y: number,
  z: number,
  scale = 1,
) {
  const m = new THREE.Mesh(geometry, mat);
  m.position.set(x, y, z);
  m.scale.setScalar(scale);
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}
function box(
  parent: THREE.Object3D,
  mat: THREE.Material,
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  d: number,
) {
  return solid(parent, new THREE.BoxGeometry(w, h, d), mat, x, y, z);
}
function labelSprite(text: string, sub = '', ink = '#273e39', disc = true) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = disc ? 256 : 96;
  const ctx = canvas.getContext('2d')!;
  if (disc) {
    ctx.shadowColor = 'rgba(20,34,23,.24)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 5;
    ctx.fillStyle = '#fff3d4';
    ctx.beginPath();
    ctx.arc(128, 123, 111, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.strokeStyle = '#d5bd83';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(128, 123, 100, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = ink;
    ctx.font = 'bold 112px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 109);
    const n = Number(text);
    const pips = n ? 6 - Math.abs(7 - n) : 0;
    for (let i = 0; i < pips; i++) {
      ctx.beginPath();
      ctx.arc(128 + (i - (pips - 1) / 2) * 20, 180, 6, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    ctx.fillStyle = 'rgba(14,50,54,.9)';
    ctx.beginPath();
    ctx.roundRect(3, 3, 250, 90, 20);
    ctx.fill();
    ctx.strokeStyle = '#8ac6bb';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#fff0cb';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 33px Arial, sans-serif';
    ctx.fillText(text, 128, sub ? 32 : 48);
    if (sub) {
      ctx.font = '24px Arial, sans-serif';
      ctx.fillStyle = '#bce0cf';
      ctx.fillText(sub, 128, 67);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: !disc });
  const sprite = new THREE.Sprite(m);
  sprite.scale.set(disc ? 0.52 : 0.86, disc ? 0.52 : 0.323, 1);
  if (disc) sprite.renderOrder = 2;
  return sprite;
}

function hexTile(parent: THREE.Group, points: { x: number; z: number }[], terrain: Terrain) {
  const rings = [
    { r: 0.965, y: -0.24 },
    { r: 0.993, y: -0.18 },
    { r: 0.993, y: 0.045 },
    { r: 0.948, y: 0.11 },
  ];
  const vertices: number[] = [];
  const groups: { start: number; count: number; materialIndex: number }[] = [];
  function triangle(a: number[], b: number[], c: number[]) {
    vertices.push(...a, ...b, ...c);
  }
  const point = (i: number, ring: number) => [
    points[i].x * rings[ring].r,
    rings[ring].y,
    points[i].z * rings[ring].r,
  ];
  for (let r = 0; r < 3; r++) {
    const start = vertices.length / 3;
    for (let i = 0; i < 6; i++) {
      const j = (i + 1) % 6;
      triangle(point(i, r), point(j, r), point(j, r + 1));
      triangle(point(i, r), point(j, r + 1), point(i, r + 1));
    }
    groups.push({ start, count: vertices.length / 3 - start, materialIndex: r === 2 ? 1 : 0 });
  }
  const start = vertices.length / 3;
  for (let i = 0; i < 6; i++) triangle([0, 0.11, 0], point(i, 3), point((i + 1) % 6, 3));
  groups.push({ start, count: vertices.length / 3 - start, materialIndex: 2 });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.computeVertexNormals();
  groups.forEach((g) => geometry.addGroup(g.start, g.count, g.materialIndex));
  const mesh = new THREE.Mesh(geometry, [
    material(TERRAIN[terrain].side, { side: THREE.DoubleSide }),
    material(new THREE.Color(TERRAIN[terrain].top).multiplyScalar(1.08), {
      side: THREE.DoubleSide,
    }),
    material(TERRAIN[terrain].top, { side: THREE.DoubleSide }),
  ]);
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

function decorateTile(group: THREE.Group, terrain: Terrain, seed: number) {
  const random = rng(seed * 127 + 9381);
  const trunk = material('#825d3a'),
    darkGreen = material('#286647'),
    midGreen = material('#3d8053'),
    lightGreen = material('#5a965b');
  const cream = material('#f2e7cb'),
    dark = material('#514c42'),
    ochre = material('#b39243');
  const stone = material('#738280'),
    paleStone = material('#c3c9bf'),
    snow = material('#eef0df');
  const clay = material('#a34e3d'),
    warmClay = material('#d68054');
  function at(angle: number, radius: number) {
    return { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius };
  }
  if (terrain === 'wood') {
    for (let i = 0; i < 8; i++) {
      const p = at((i / 8) * Math.PI * 2 + random() * 0.2, 0.53 + random() * 0.12);
      const height = 0.37 + random() * 0.26;
      const radius = 0.12 + random() * 0.045;
      solid(
        group,
        new THREE.CylinderGeometry(0.025, 0.033, height * 0.5, 5),
        trunk,
        p.x,
        0.16 + height * 0.18,
        p.z,
      );
      solid(
        group,
        new THREE.ConeGeometry(radius, height * 0.68, 6),
        i % 2 ? midGreen : darkGreen,
        p.x,
        0.18 + height * 0.55,
        p.z,
      );
      solid(
        group,
        new THREE.ConeGeometry(radius * 0.77, height * 0.61, 6),
        i % 3 ? darkGreen : lightGreen,
        p.x,
        0.18 + height * 0.86,
        p.z,
      );
    }
    for (let i = 0; i < 5; i++) {
      const p = at(random() * 6.28, 0.52 + random() * 0.15);
      solid(group, new THREE.IcosahedronGeometry(0.048, 0), ochre, p.x, 0.125, p.z);
    }
  } else if (terrain === 'wheat') {
    const stem = material('#ad8a35');
    const heads = material('#f3d982');
    const furrow = material('#bca154');
    const field = new THREE.Group();
    field.rotation.y = -0.35;
    group.add(field);
    for (const side of [-1, 1]) {
      for (let row = 0; row < 4; row++) {
        const z = side * (0.38 + row * 0.095);
        box(field, furrow, 0, 0.118, z, 0.82 - row * 0.11, 0.014, 0.045);
        for (let col = 0; col < 6 - (row > 1 ? 1 : 0); col++) {
          const x = (col - (5 - (row > 1 ? 1 : 0)) / 2) * 0.118;
          const h = 0.105 + random() * 0.045;
          solid(field, new THREE.CylinderGeometry(0.007, 0.01, h, 3), stem, x, 0.13 + h / 2, z);
          const head = solid(field, new THREE.SphereGeometry(0.026, 4, 3), heads, x, 0.14 + h, z);
          head.scale.set(0.64, 1.65, 0.64);
          head.rotation.z = -0.2;
        }
      }
    }
    const bale = solid(
      group,
      new THREE.CylinderGeometry(0.072, 0.072, 0.14, 9),
      heads,
      0.57,
      0.19,
      -0.03,
    );
    bale.rotation.z = Math.PI / 2;
    const band = solid(
      group,
      new THREE.CylinderGeometry(0.073, 0.073, 0.023, 9),
      ochre,
      0.57,
      0.19,
      -0.03,
    );
    band.rotation.z = Math.PI / 2;
  } else if (terrain === 'sheep') {
    const grass = material('#679b52');
    for (let i = 0; i < 4; i++) {
      const p = at(i * 1.8 + 0.7, 0.49 + random() * 0.14);
      const sheep = new THREE.Group();
      sheep.position.set(p.x, 0.115, p.z);
      sheep.rotation.y = random() * 6.28;
      group.add(sheep);
      const body = solid(sheep, new THREE.IcosahedronGeometry(0.105, 1), cream, 0, 0.105, 0);
      body.scale.set(1.2, 0.82, 0.85);
      solid(sheep, new THREE.IcosahedronGeometry(0.048, 0), dark, 0.103, 0.127, 0);
      for (const x of [-0.056, 0.05])
        for (const z of [-0.045, 0.045]) box(sheep, dark, x, 0.035, z, 0.021, 0.065, 0.021);
      box(sheep, cream, 0.105, 0.16, 0, 0.04, 0.018, 0.12);
    }
    for (let i = 0; i < 8; i++) {
      const p = at(i * 1.87, 0.6 + random() * 0.12);
      solid(group, new THREE.ConeGeometry(0.034, 0.085, 3), grass, p.x, 0.15, p.z);
    }
    const fence = new THREE.Group();
    fence.position.set(0, 0.12, 0.7);
    group.add(fence);
    for (const x of [-0.22, 0, 0.22]) box(fence, cream, x, 0.067, 0, 0.019, 0.135, 0.023);
    for (const y of [0.047, 0.105]) box(fence, cream, 0, y, 0, 0.48, 0.019, 0.019);
  } else if (terrain === 'brick') {
    for (let i = 0; i < 5; i++) {
      const p = at(i * 1.49 + 0.3, 0.55 + random() * 0.09);
      const hill = solid(
        group,
        new THREE.IcosahedronGeometry(0.21 + random() * 0.07, 0),
        i % 2 ? clay : warmClay,
        p.x,
        0.17,
        p.z,
      );
      hill.scale.set(1, 0.85 + random() * 0.9, 0.82);
      hill.rotation.y = i;
    }
    for (let row = 0; row < 3; row++)
      for (let col = 0; col < 3 - row; col++)
        box(
          group,
          row % 2 ? warmClay : clay,
          -0.16 + col * 0.13 + row * 0.055,
          0.15 + row * 0.061,
          0.66,
          0.12,
          0.055,
          0.09,
        );
  } else if (terrain === 'ore') {
    for (let i = 0; i < 4; i++) {
      const p = at(i * 1.72 + 0.5, 0.54 + random() * 0.055);
      const h = 0.43 + random() * 0.41;
      const radius = 0.23 + random() * 0.045;
      const mountain = solid(
        group,
        new THREE.ConeGeometry(radius, h, 5),
        i % 2 ? stone : paleStone,
        p.x,
        0.105 + h / 2,
        p.z,
      );
      mountain.rotation.y = i * 0.6;
      const peak = solid(
        group,
        new THREE.ConeGeometry(radius * 0.28, h * 0.28, 5),
        snow,
        p.x,
        0.109 + h * 0.86,
        p.z,
      );
      peak.rotation.y = mountain.rotation.y;
      for (let j = 0; j < 2; j++)
        solid(
          group,
          new THREE.DodecahedronGeometry(0.067 + random() * 0.025),
          stone,
          p.x + (random() - 0.5) * 0.36,
          0.15,
          p.z + (random() - 0.5) * 0.25,
        );
    }
  } else {
    const sand = material('#edce91'),
      cactus = material('#618966');
    for (let i = 0; i < 4; i++) {
      const p = at(i * 1.7, 0.54);
      const dune = solid(group, new THREE.SphereGeometry(0.23, 8, 5), sand, p.x, 0.1, p.z);
      dune.scale.set(1.3, 0.38, 0.6);
      dune.rotation.y = i;
    }
    const x = -0.53,
      z = 0.22;
    solid(group, new THREE.CapsuleGeometry(0.025, 0.17, 3, 5), cactus, x, 0.25, z);
    box(group, cactus, x + 0.05, 0.24, z, 0.12, 0.033, 0.034);
    solid(group, new THREE.CapsuleGeometry(0.018, 0.065, 3, 5), cactus, x + 0.105, 0.275, z);
    solid(group, new THREE.CapsuleGeometry(0.018, 0.06, 3, 5), cactus, x - 0.045, 0.31, z);
  }
}

function building(
  parent: THREE.Group,
  type: 'settlement' | 'city',
  color: string,
  x: number,
  z: number,
) {
  const group = new THREE.Group();
  group.position.set(x, 0.13, z);
  group.rotation.y = Math.PI / 6;
  parent.add(group);
  const painted = material(color, { roughness: 0.55 }),
    roof = material(new THREE.Color(color).multiplyScalar(0.66)),
    light = material('#ffe9ad'),
    base = material('#e9d7b4');
  const scale = type === 'city' ? 1.15 : 1;
  group.scale.setScalar(scale);
  box(group, base, 0, 0.016, 0, type === 'city' ? 0.33 : 0.24, 0.045, 0.24);
  box(group, painted, 0, 0.14, 0, 0.2, 0.23, 0.19);
  const roofShape = new THREE.Shape();
  roofShape.moveTo(-0.135, 0);
  roofShape.lineTo(0.135, 0);
  roofShape.lineTo(0, 0.13);
  roofShape.closePath();
  solid(
    group,
    new THREE.ExtrudeGeometry(roofShape, { depth: 0.24, bevelEnabled: false }),
    roof,
    0,
    0.255,
    -0.12,
  );
  box(group, light, 0, 0.095, 0.097, 0.048, 0.093, 0.006);
  box(group, light, -0.102, 0.185, 0.035, 0.005, 0.038, 0.042);
  if (type === 'city') {
    box(group, painted, -0.125, 0.22, -0.015, 0.13, 0.39, 0.14);
    solid(group, new THREE.ConeGeometry(0.11, 0.14, 4), roof, -0.125, 0.48, -0.015).rotation.y =
      Math.PI / 4;
    box(group, light, -0.125, 0.315, 0.057, 0.035, 0.055, 0.005);
    box(group, painted, 0.115, 0.085, 0, 0.1, 0.12, 0.16);
    box(group, roof, 0.115, 0.155, 0, 0.12, 0.032, 0.18);
  }
  return group;
}

function harbor(parent: THREE.Group, x: number, z: number, index: number, type: string) {
  const group = new THREE.Group();
  group.position.set(x, -0.115, z);
  group.rotation.y = Math.atan2(x, z);
  parent.add(group);
  const wood = material('#ae8656'),
    darkWood = material('#735233'),
    rope = material('#e7c99a');
  for (let i = 0; i < 7; i++) box(group, wood, 0, 0.03, -0.31 + i * 0.093, 0.28, 0.038, 0.075);
  for (const side of [-1, 1])
    for (const k of [-0.28, 0.22]) {
      solid(
        group,
        new THREE.CylinderGeometry(0.027, 0.03, 0.24, 6),
        darkWood,
        side * 0.14,
        0.025,
        k,
      );
      solid(group, new THREE.CylinderGeometry(0.032, 0.032, 0.035, 7), rope, side * 0.14, 0.095, k);
    }
  const boat = new THREE.Group();
  boat.position.set(0.3, 0, 0.35);
  boat.rotation.y = -0.3;
  group.add(boat);
  const hull = solid(
    boat,
    new THREE.SphereGeometry(0.18, 7, 4),
    material(index % 2 ? '#bd654b' : '#e5bf6a'),
    0,
    0.022,
    0,
  );
  hull.scale.set(0.74, 0.4, 1.45);
  box(boat, darkWood, 0, 0.058, 0, 0.14, 0.02, 0.31);
  solid(boat, new THREE.CylinderGeometry(0.012, 0.016, 0.47, 5), darkWood, 0, 0.27, 0);
  const sailGeo = new THREE.BufferGeometry();
  sailGeo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([0.015, 0.48, 0, 0.015, 0.12, 0.02, 0.22, 0.17, 0.035], 3),
  );
  sailGeo.computeVertexNormals();
  solid(boat, sailGeo, material('#fff1d4', { side: THREE.DoubleSide }), 0, 0, 0);
  const flag = box(boat, material('#c86b4a'), 0.045, 0.48, 0, 0.1, 0.045, 0.012);
  flag.rotation.y = 0.3;
  const label = labelSprite(
    type === 'any' ? '3:1' : '2:1',
    type === 'any' ? 'ANY' : RES_NAMES[type].toUpperCase(),
    '#fff',
    false,
  );
  label.position.set(-0.04, 0.46, 0.11);
  group.add(label);
  return boat;
}

export default function Board3D({
  state,
  buildKind,
  legalIds,
  onVertex,
  onEdge,
  onHex,
  interactive,
  resetView = 0,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const current = useRef({ state, buildKind, legalIds, onVertex, onEdge, onHex, interactive });
  current.current = { state, buildKind, legalIds, onVertex, onEdge, onHex, interactive };
  const [hover, setHover] = useState<Hover>(null);
  const [error, setError] = useState(false);
  const sceneRef = useRef<{
    scene: THREE.Scene;
    renderer: THREE.WebGLRenderer;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    pieces: THREE.Group;
    targets: THREE.Object3D[];
    terrainTargets: THREE.Object3D[];
    pulse: THREE.Mesh[];
    baseDistance: number;
    center: THREE.Vector3;
  } | null>(null);
  const topology =
    state.config.seed +
    ':' +
    state.config.mode +
    ':' +
    state.board.hexes.map((h) => `${h.id},${h.terrain},${h.number}`).join('|');

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: 'high-performance',
      });
    } catch {
      setError(true);
      return;
    }
    setError(false);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.8));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // The land and sun are stationary. Rebuild shadows only when game pieces change.
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.domElement.setAttribute(
      'aria-label',
      'Interactive 3D island. Drag to rotate, scroll to zoom, and click highlighted locations to build.',
    );
    renderer.domElement.setAttribute('role', 'img');
    renderer.domElement.style.touchAction = 'none';
    container.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#173d43');
    scene.fog = new THREE.FogExp2('#173d43', 0.027);
    const island = new THREE.Group();
    scene.add(island);
    const board = current.current.state.board;
    const minX = Math.min(...board.hexes.map((h) => h.x)) - 1,
      maxX = Math.max(...board.hexes.map((h) => h.x)) + 1;
    const minZ = Math.min(...board.hexes.map((h) => h.z)) - 1,
      maxZ = Math.max(...board.hexes.map((h) => h.z)) + 1;
    const center = new THREE.Vector3((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
    const extent = Math.max(maxX - minX, maxZ - minZ);
    const baseDistance = extent * 1.5;
    const camera = new THREE.PerspectiveCamera(37, 1, 0.1, 120);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    controls.minPolarAngle = 0.23;
    controls.maxPolarAngle = Math.PI / 2.6;
    controls.minDistance = extent * 0.8;
    controls.maxDistance = extent * 2.8;
    controls.enablePan = true;
    controls.maxTargetRadius = extent * 0.4;
    controls.target.copy(center);
    camera.position.set(
      center.x + baseDistance * 0.1,
      baseDistance * 0.86,
      center.z + baseDistance * 0.9,
    );
    controls.update();
    scene.add(new THREE.HemisphereLight('#f5f3d7', '#446870', 2.7));
    const sun = new THREE.DirectionalLight('#fff0cf', 3.2);
    sun.position.set(-5, 13, 7);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -11;
    sun.shadow.camera.right = 11;
    sun.shadow.camera.top = 11;
    sun.shadow.camera.bottom = -11;
    sun.shadow.normalBias = 0.035;
    sun.shadow.bias = -0.00015;
    sun.shadow.radius = 3;
    scene.add(sun);
    const fill = new THREE.DirectionalLight('#bce8e2', 1.3);
    fill.position.set(5, 7, -7);
    scene.add(fill);
    const waterMaterial = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        center: { value: new THREE.Vector2(center.x, center.z) },
        radius: { value: extent * 0.52 },
      },
      vertexShader:
        'varying vec3 vWorld; void main(){ vec4 p=modelMatrix*vec4(position,1.0); vWorld=p.xyz; gl_Position=projectionMatrix*viewMatrix*p; }',
      fragmentShader: `uniform float time; uniform vec2 center; uniform float radius; varying vec3 vWorld;
      void main(){ vec2 p=vWorld.xz-center; float d=length(p); float nearShore=1.-smoothstep(radius*.7,radius*1.8,d);
      vec3 deep=vec3(.045,.18,.21); vec3 shallow=vec3(.10,.39,.40); vec3 col=mix(deep,shallow,nearShore*.82);
      float ripple=sin(p.x*3.+p.y*4.-time*.6)*sin(p.x*4.-p.y*2.+time*.35); col+=ripple*.012;
      float shimmer=pow(max(0.,sin(p.x*15.+p.y*21.+sin(p.y*5.)-time*.7)),38.); col+=vec3(.13,.24,.20)*shimmer*nearShore*.23;
      gl_FragColor=vec4(col,1.); }`,
    });
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), waterMaterial);
    sea.rotation.x = -Math.PI / 2;
    sea.position.y = -0.285;
    scene.add(sea);
    const terrainTargets: THREE.Object3D[] = [];
    for (const hex of board.hexes) {
      const tile = new THREE.Group();
      tile.position.set(hex.x, 0, hex.z);
      island.add(tile);
      const points = hex.vertices
        .map((id) => board.vertices.find((v) => v.id === id)!)
        .map((v) => ({ x: v.x - hex.x, z: v.z - hex.z }));
      const mesh = hexTile(tile, points, hex.terrain);
      mesh.userData.hit = {
        kind: 'hex',
        id: hex.id,
        label: `${TERRAIN[hex.terrain].label}${hex.number ? ` · ${hex.number}` : ''}`,
        actionable: false,
      } satisfies Hit;
      terrainTargets.push(mesh);
      decorateTile(tile, hex.terrain, hex.id + 117);
      if (hex.number) {
        const token = labelSprite(
          String(hex.number),
          '',
          [6, 8].includes(hex.number) ? '#b74e3c' : '#3d4a3d',
        );
        token.position.set(0, 0.26, 0.05);
        tile.add(token);
      }
    }
    // Pale waterline follows the actual island boundary, including the extended board.
    const shoreMaterial = new THREE.MeshBasicMaterial({
      color: '#b5dcbd',
      transparent: true,
      opacity: 0.27,
      depthWrite: false,
    });
    for (const edge of board.edges) {
      const a = board.vertices.find((v) => v.id === edge.a)!,
        b = board.vertices.find((v) => v.id === edge.b)!;
      if (a.hexes.filter((h) => b.hexes.includes(h)).length !== 1) continue;
      const mid = new THREE.Vector3((a.x + b.x) / 2, 0, (a.z + b.z) / 2);
      const outward = new THREE.Vector3(mid.x - center.x, 0, mid.z - center.z).normalize();
      const line = new THREE.Mesh(
        new THREE.PlaneGeometry(Math.hypot(a.x - b.x, a.z - b.z) * 0.96, 0.1),
        shoreMaterial,
      );
      line.rotation.x = -Math.PI / 2;
      line.rotation.z = -Math.atan2(b.z - a.z, b.x - a.x);
      line.position.set(mid.x + outward.x * 0.09, -0.267, mid.z + outward.z * 0.09);
      scene.add(line);
    }
    const boats: THREE.Group[] = [];
    for (const port of board.ports) {
      const direction = new THREE.Vector2(port.x - center.x, port.z - center.z).normalize();
      boats.push(
        harbor(
          island,
          port.x + direction.x * 0.08,
          port.z + direction.y * 0.08,
          port.id,
          port.type,
        ),
      );
    }
    // Keep the exact artwork, but submit matching static surfaces together instead
    // of issuing one WebGL draw for every grain stalk, tree branch, and dock plank.
    const batched = batchStaticMeshes(island, new Set(boats));
    renderer.domElement.dataset.staticMeshesBefore = String(batched.before);
    renderer.domElement.dataset.staticMeshesAfter = String(batched.after);
    const glints: THREE.Mesh[] = [];
    const random = rng(726);
    for (let i = 0; i < 75; i++) {
      const angle = random() * Math.PI * 2,
        distance = extent * (0.62 + random() * 0.75);
      const glint = new THREE.Mesh(
        new THREE.PlaneGeometry(0.09 + random() * 0.28, 0.014),
        new THREE.MeshBasicMaterial({
          color: '#aedfce',
          transparent: true,
          opacity: 0.16 + random() * 0.18,
          depthWrite: false,
        }),
      );
      glint.rotation.x = -Math.PI / 2;
      glint.position.set(
        center.x + Math.cos(angle) * distance,
        -0.265,
        center.z + Math.sin(angle) * distance,
      );
      scene.add(glint);
      glints.push(glint);
    }
    const pieces = new THREE.Group();
    scene.add(pieces);
    sceneRef.current = {
      scene,
      renderer,
      camera,
      controls,
      pieces,
      targets: [],
      terrainTargets,
      pulse: [],
      baseDistance,
      center,
    };
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let down: { x: number; y: number } | null = null;
    const hitAt = (event: PointerEvent): Hit | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      const ref = sceneRef.current;
      if (!ref) return null;
      const markerHit = raycaster.intersectObjects(ref.targets, false)[0];
      if (markerHit) return markerHit.object.userData.hit ?? null;
      const tileHit = raycaster.intersectObjects(ref.terrainTargets, false)[0];
      if (!tileHit) return null;
      const hit = { ...tileHit.object.userData.hit } as Hit;
      hit.actionable =
        current.current.interactive &&
        current.current.state.phase === 'robber' &&
        hit.id !== current.current.state.robberHex;
      return hit;
    };
    const move = (event: PointerEvent) => {
      if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) {
        setHover(null);
        return;
      }
      const hit = hitAt(event);
      renderer.domElement.style.cursor = hit?.actionable ? 'pointer' : 'grab';
      if (hit) {
        const rect = container.getBoundingClientRect();
        setHover({
          label: hit.actionable && hit.kind === 'hex' ? 'Move robber here' : hit.label,
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        });
      } else setHover(null);
    };
    const pointerDown = (event: PointerEvent) => {
      down = { x: event.clientX, y: event.clientY };
    };
    const pointerUp = (event: PointerEvent) => {
      if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) {
        down = null;
        return;
      }
      down = null;
      const hit = hitAt(event);
      if (!hit?.actionable || !current.current.interactive) return;
      setHover(null);
      const latest = current.current;
      if (hit.kind === 'vertex') latest.onVertex(hit.id);
      else if (hit.kind === 'edge') latest.onEdge(hit.id);
      else latest.onHex(hit.id);
    };
    const leave = () => {
      setHover(null);
      down = null;
    };
    renderer.domElement.addEventListener('pointermove', move);
    renderer.domElement.addEventListener('pointerdown', pointerDown);
    renderer.domElement.addEventListener('pointerup', pointerUp);
    renderer.domElement.addEventListener('pointerleave', leave);
    let firstSize = true;
    const resize = () => {
      const width = container.clientWidth,
        height = container.clientHeight;
      if (!width || !height) return;
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      if (firstSize) {
        if (camera.aspect < 1.2)
          camera.position
            .sub(center)
            .multiplyScalar(Math.min(1.5, 1.2 / camera.aspect))
            .add(center);
        firstSize = false;
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();
    const clock = new THREE.Clock();
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let animation = 0;
    let lastFrame = -Infinity;
    const animate = (now = performance.now()) => {
      animation = requestAnimationFrame(animate);
      // Multiplayer tabs need not redraw an unchanged, hidden board. A gentle
      // 30 fps sea animation also leaves headroom for several open game clients.
      if (document.hidden || now - lastFrame < 1000 / (reducedMotion.matches ? 12 : 30)) return;
      lastFrame = now;
      const elapsed = reducedMotion.matches ? 0 : clock.getElapsedTime();
      waterMaterial.uniforms.time.value = elapsed;
      boats.forEach((boat, i) => {
        boat.position.y = Math.sin(elapsed * 1.2 + i) * 0.012;
        boat.rotation.z = Math.sin(elapsed * 0.8 + i) * 0.025;
      });
      glints.forEach((glint, i) => {
        (glint.material as THREE.MeshBasicMaterial).opacity =
          0.08 + (Math.sin(elapsed * 0.8 + i * 2.1) + 1) * 0.075;
      });
      sceneRef.current?.pulse.forEach((mesh, i) => {
        (mesh.material as THREE.MeshStandardMaterial).emissiveIntensity =
          0.4 + Math.sin(elapsed * 2.8 + i * 0.2) * 0.2;
      });
      controls.update();
      renderer.render(scene, camera);
      renderer.domElement.dataset.drawCalls = String(renderer.info.render.calls);
    };
    animate();
    return () => {
      cancelAnimationFrame(animation);
      observer.disconnect();
      controls.dispose();
      renderer.domElement.removeEventListener('pointermove', move);
      renderer.domElement.removeEventListener('pointerdown', pointerDown);
      renderer.domElement.removeEventListener('pointerup', pointerUp);
      renderer.domElement.removeEventListener('pointerleave', leave);
      disposeGroup(scene);
      renderer.dispose();
      renderer.domElement.remove();
      sceneRef.current = null;
    };
  }, [topology]);

  useEffect(() => {
    const ref = sceneRef.current;
    if (!ref) return;
    disposeGroup(ref.pieces);
    ref.pieces.clear();
    ref.targets = [];
    ref.pulse = [];
    const { board, players } = state;
    for (const edge of board.edges) {
      if (edge.owner === null) continue;
      const a = board.vertices.find((v) => v.id === edge.a)!,
        b = board.vertices.find((v) => v.id === edge.b)!;
      const road = box(
        ref.pieces,
        material(players[edge.owner]?.color ?? '#cc6948', { roughness: 0.55 }),
        (a.x + b.x) / 2,
        0.16,
        (a.z + b.z) / 2,
        Math.hypot(a.x - b.x, a.z - b.z) * 0.72,
        0.085,
        0.09,
      );
      road.rotation.y = -Math.atan2(b.z - a.z, b.x - a.x);
      road.userData.hit = {
        kind: 'edge',
        id: edge.id,
        label: `${players[edge.owner]?.name}'s road`,
        actionable: false,
      } satisfies Hit;
    }
    for (const vertex of board.vertices)
      if (vertex.building)
        building(
          ref.pieces,
          vertex.building.type,
          players[vertex.building.owner]?.color ?? '#cc6948',
          vertex.x,
          vertex.z,
        );
    const hex = board.hexes.find((h) => h.id === state.robberHex);
    if (hex) {
      const robber = new THREE.Group();
      robber.position.set(hex.x + 0.27, 0.13, hex.z - 0.2);
      ref.pieces.add(robber);
      const black = material('#263b3b', { roughness: 0.45 }),
        trim = material('#bf9d64');
      solid(robber, new THREE.CylinderGeometry(0.105, 0.125, 0.038, 12), trim, 0, 0.02, 0);
      solid(robber, new THREE.ConeGeometry(0.105, 0.3, 9), black, 0, 0.17, 0);
      solid(robber, new THREE.SphereGeometry(0.073, 9, 7), black, 0, 0.36, 0);
      solid(robber, new THREE.CylinderGeometry(0.14, 0.14, 0.032, 10), black, 0, 0.4, 0);
      solid(robber, new THREE.CylinderGeometry(0.062, 0.076, 0.09, 9), black, 0, 0.45, 0);
    }
    if (interactive && state.phase === 'robber') {
      const outlineMaterial = new THREE.LineBasicMaterial({
        color: '#ffe2a0',
        transparent: true,
        opacity: 0.72,
      });
      for (const target of board.hexes) {
        if (target.id === state.robberHex) continue;
        const points = target.vertices.map((id) => {
          const v = board.vertices.find((vertex) => vertex.id === id)!;
          return new THREE.Vector3(
            target.x + (v.x - target.x) * 0.9,
            0.13,
            target.z + (v.z - target.z) * 0.9,
          );
        });
        ref.pieces.add(
          new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), outlineMaterial),
        );
      }
    }
    if (interactive && buildKind) {
      const color = players[state.currentPlayer]?.color ?? '#efb469';
      for (const id of legalIds) {
        const markerMaterial = material('#ffe7ab', {
          emissive: '#f7d791',
          emissiveIntensity: 0.45,
          transparent: true,
          opacity: 0.88,
          roughness: 0.35,
          depthTest: false,
        });
        let marker: THREE.Mesh;
        if (buildKind === 'road') {
          const edge = board.edges.find((e) => e.id === id);
          if (!edge) continue;
          const a = board.vertices.find((v) => v.id === edge.a)!,
            b = board.vertices.find((v) => v.id === edge.b)!;
          marker = box(
            ref.pieces,
            markerMaterial,
            (a.x + b.x) / 2,
            0.19,
            (a.z + b.z) / 2,
            Math.hypot(a.x - b.x, a.z - b.z) * 0.62,
            0.035,
            0.07,
          );
          marker.rotation.y = -Math.atan2(b.z - a.z, b.x - a.x);
          const hit = box(
            ref.pieces,
            new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
            marker.position.x,
            0.23,
            marker.position.z,
            Math.hypot(a.x - b.x, a.z - b.z) * 0.84,
            0.12,
            0.23,
          );
          hit.rotation.y = marker.rotation.y;
          hit.userData.hit = {
            kind: 'edge',
            id,
            label: 'Build road here',
            actionable: true,
          } satisfies Hit;
          hit.visible = false; // Raycast proxies never need a rendering pass.
          ref.targets.push(hit);
        } else {
          const vertex = board.vertices.find((v) => v.id === id);
          if (!vertex) continue;
          marker = solid(
            ref.pieces,
            new THREE.TorusGeometry(buildKind === 'city' ? 0.21 : 0.145, 0.022, 6, 20),
            markerMaterial,
            vertex.x,
            0.16,
            vertex.z,
          );
          marker.rotation.x = Math.PI / 2;
          const dot = solid(
            ref.pieces,
            new THREE.CircleGeometry(0.06, 16),
            material(color, {
              emissive: color,
              emissiveIntensity: 0.5,
              side: THREE.DoubleSide,
              depthTest: false,
            }),
            vertex.x,
            0.165,
            vertex.z,
          );
          dot.rotation.x = -Math.PI / 2;
          dot.renderOrder = 3;
          const hit = solid(
            ref.pieces,
            new THREE.SphereGeometry(0.23, 8, 6),
            new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
            vertex.x,
            0.18,
            vertex.z,
          );
          hit.userData.hit = {
            kind: 'vertex',
            id,
            label: `Build ${buildKind} here`,
            actionable: true,
          } satisfies Hit;
          hit.visible = false; // Raycast proxies never need a rendering pass.
          ref.targets.push(hit);
        }
        marker.castShadow = false;
        marker.renderOrder = 3;
        ref.pulse.push(marker);
      }
    }
    ref.renderer.shadowMap.needsUpdate = true;
  }, [state, buildKind, legalIds, interactive, topology]);

  useEffect(() => {
    if (!resetView) return;
    const ref = sceneRef.current;
    if (!ref) return;
    ref.controls.target.copy(ref.center);
    ref.camera.position.set(
      ref.center.x + ref.baseDistance * 0.1,
      ref.baseDistance * 0.86,
      ref.center.z + ref.baseDistance * 0.9,
    );
    if (ref.camera.aspect < 1.2)
      ref.camera.position
        .sub(ref.center)
        .multiplyScalar(Math.min(1.5, 1.2 / ref.camera.aspect))
        .add(ref.center);
    ref.controls.update();
  }, [resetView]);

  return (
    <div
      className="board-3d"
      ref={host}
      style={{
        width: '100%',
        height: '100%',
        minHeight: 360,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {error && (
        <div
          role="alert"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeContent: 'center',
            padding: 40,
            textAlign: 'center',
            color: '#fff3d8',
          }}
        >
          <strong>WebGL is needed to explore the island.</strong>
          <p>Enable hardware acceleration in your browser, then refresh to load the 3D board.</p>
        </div>
      )}
      {hover && (
        <div
          className="board-tooltip"
          style={{
            pointerEvents: 'none',
            position: 'absolute',
            left: Math.min(hover.x + 14, Math.max(10, (host.current?.clientWidth ?? 400) - 230)),
            top: Math.max(8, hover.y - 45),
            zIndex: 5,
            background: '#102e32f2',
            border: '1px solid #8bbcb252',
            borderRadius: 8,
            color: '#f6efdc',
            padding: '9px 12px',
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: '.01em',
            boxShadow: '0 8px 24px #0003',
          }}
        >
          {hover.label}
        </div>
      )}
    </div>
  );
}

/** Bake nested transforms and batch identical static materials without changing art. */
function batchStaticMeshes(root: THREE.Group, movingRoots: Set<THREE.Object3D>) {
  root.updateMatrixWorld(true);
  const inverseRoot = root.matrixWorld.clone().invert();
  const buckets = new Map<string, { material: THREE.MeshStandardMaterial; meshes: THREE.Mesh[] }>();
  root.traverse((object) => {
    if (
      !(object instanceof THREE.Mesh) ||
      object.userData.hit ||
      !object.visible ||
      !(object.material instanceof THREE.MeshStandardMaterial)
    )
      return;
    for (let ancestor: THREE.Object3D | null = object; ancestor; ancestor = ancestor.parent) {
      if (movingRoots.has(ancestor)) return;
      if (ancestor === root) break;
    }
    const mat = object.material;
    const key = JSON.stringify([
      mat.color.getHex(),
      mat.emissive.getHex(),
      mat.emissiveIntensity,
      mat.roughness,
      mat.metalness,
      mat.opacity,
      mat.transparent,
      mat.side,
      mat.flatShading,
      mat.depthTest,
      mat.depthWrite,
      object.castShadow,
      object.receiveShadow,
      Object.entries(object.geometry.attributes)
        .map(([name, attribute]) => [name, (attribute as THREE.BufferAttribute).itemSize])
        .sort(),
    ]);
    const bucket = buckets.get(key);
    if (bucket) bucket.meshes.push(object);
    else buckets.set(key, { material: mat, meshes: [object] });
  });
  let before = 0,
    after = 0;
  const retiredMaterials = new Set<THREE.Material>();
  const retiredGeometries = new Set<THREE.BufferGeometry>();
  for (const { material: mat, meshes } of buckets.values()) {
    before += meshes.length;
    if (meshes.length === 1) {
      after++;
      continue;
    }
    const geometries = meshes.map((mesh) => {
      // Primitives use a mix of indexed and unindexed geometry. Normalize before
      // merging while preserving their original UVs and face normals.
      const geometry = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
      return geometry.applyMatrix4(
        new THREE.Matrix4().multiplyMatrices(inverseRoot, mesh.matrixWorld),
      );
    });
    const geometry = mergeGeometries(geometries, false);
    geometries.forEach((part) => part.dispose());
    if (!geometry) {
      after += meshes.length;
      continue;
    }
    const merged = new THREE.Mesh(geometry, mat);
    merged.castShadow = meshes[0].castShadow;
    merged.receiveShadow = meshes[0].receiveShadow;
    root.add(merged);
    for (const mesh of meshes) {
      mesh.removeFromParent();
      retiredGeometries.add(mesh.geometry);
      retiredMaterials.add(mesh.material as THREE.Material);
    }
    after++;
  }
  // A dock and its animated boat can share a material: retain those references.
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.material)
      for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material])
        retiredMaterials.delete(mat);
    if (mesh.geometry) retiredGeometries.delete(mesh.geometry);
  });
  retiredGeometries.forEach((geometry) => geometry.dispose());
  retiredMaterials.forEach((mat) => mat.dispose());
  return { before, after };
}

function disposeGroup(group: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>(),
    materials = new Set<THREE.Material>(),
    textures = new Set<THREE.Texture>();
  group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    if (mesh.material)
      for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        materials.add(mat);
        for (const value of Object.values(mat))
          if (value instanceof THREE.Texture) textures.add(value);
      }
  });
  geometries.forEach((geometry) => geometry.dispose());
  textures.forEach((texture) => texture.dispose());
  materials.forEach((mat) => mat.dispose());
}
