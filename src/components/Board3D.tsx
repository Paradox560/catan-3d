import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { BuildKind, GameState, Terrain } from '../game/types';
import {
  createTerrainMaterials,
  sculptedHex,
  decorateRealTerrain,
  medievalBuilding as building,
} from './TerrainScenery';

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
    ctx.fillStyle = '#d9c79e';
    ctx.beginPath();
    ctx.arc(128, 123, 111, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.strokeStyle = '#957846';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(128, 123, 100, 0, Math.PI * 2);
    ctx.stroke();
    for (let i = 0; i < 700; i++) {
      const a = i * 2.399,
        r = Math.sqrt(i / 700) * 97;
      ctx.fillStyle = i % 2 ? '#705c3720' : '#ffedc220';
      ctx.fillRect(128 + Math.cos(a) * r, 123 + Math.sin(a) * r, 2, 1);
    }
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
    ctx.fillStyle = 'rgba(48,39,27,.94)';
    ctx.beginPath();
    ctx.roundRect(3, 3, 250, 90, 20);
    ctx.fill();
    ctx.strokeStyle = '#a68a58';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#fff0cb';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 33px Georgia, serif';
    ctx.fillText(text, 128, sub ? 32 : 48);
    if (sub) {
      ctx.font = '24px Arial, sans-serif';
      ctx.fillStyle = '#d4c19a';
      ctx.fillText(sub, 128, 67);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: !disc });
  const sprite = new THREE.Sprite(m);
  sprite.scale.set(disc ? 0.46 : 0.86, disc ? 0.46 : 0.323, 1);
  if (disc) sprite.renderOrder = 2;
  return sprite;
}

function harbor(parent: THREE.Group, x: number, z: number, index: number, type: string) {
  const group = new THREE.Group();
  group.position.set(x, -0.04, z);
  group.rotation.y = Math.atan2(x, z);
  parent.add(group);
  const wood = material('#8f7756'),
    darkWood = material('#574536'),
    rope = material('#b5a78b');
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
    new THREE.SphereGeometry(0.18, 18, 10),
    material(index % 2 ? '#745440' : '#816248', { flatShading: false }),
    0,
    0.022,
    0,
  );
  hull.scale.set(0.74, 0.4, 1.45);
  box(boat, darkWood, 0, 0.058, 0, 0.14, 0.02, 0.31);
  for (let plank = 0; plank < 7; plank++)
    box(boat, wood, 0, 0.073, -0.14 + plank * 0.043, 0.145, 0.009, 0.038);
  for (const x of [-0.073, 0.073]) box(boat, darkWood, x, 0.089, 0, 0.012, 0.031, 0.25);
  const ropeLine = (a: number[], b: number[]) => {
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(...a),
      new THREE.Vector3(...b),
    ]);
    boat.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color: '#b7aa8c' })));
  };
  ropeLine([0, 0.475, 0], [0, 0.081, 0.2]);
  ropeLine([0, 0.475, 0], [0, 0.081, -0.2]);
  ropeLine([0, 0.345, 0], [-0.072, 0.081, 0.1]);
  ropeLine([0, 0.345, 0], [0.072, 0.081, 0.1]);
  solid(boat, new THREE.CylinderGeometry(0.012, 0.016, 0.47, 5), darkWood, 0, 0.27, 0);
  const sailGeo = new THREE.BufferGeometry();
  sailGeo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [0.015, 0.48, 0, 0.015, 0.12, 0.02, 0.22, 0.17, 0.035, 0.095, 0.25, 0.067],
      3,
    ),
  );
  sailGeo.setIndex([0, 1, 3, 0, 3, 2, 1, 2, 3]);
  sailGeo.computeVertexNormals();
  solid(
    boat,
    sailGeo,
    material('#d9c9a6', { side: THREE.DoubleSide, flatShading: false }),
    0,
    0,
    0,
  );
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
    renderer.toneMappingExposure = 0.97;
    renderer.domElement.setAttribute(
      'aria-label',
      'Interactive 3D island. Drag to rotate, scroll to zoom, and click highlighted locations to build.',
    );
    renderer.domElement.setAttribute('role', 'img');
    renderer.domElement.style.touchAction = 'none';
    container.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#233e43');
    scene.fog = new THREE.FogExp2('#617679', 0.012);
    const island = new THREE.Group();
    scene.add(island);
    const board = current.current.state.board;
    const terrainSurfaces = createTerrainMaterials();
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
    scene.add(new THREE.HemisphereLight('#dbe1d2', '#4e5146', 1.25));
    const sun = new THREE.DirectionalLight('#ffdfb0', 3.35);
    sun.position.set(-7, 10, 6);
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
    const fill = new THREE.DirectionalLight('#c2d7df', 0.6);
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
      float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
      float noise(vec2 p){vec2 i=floor(p),f=fract(p); f=f*f*(3.-2.*f); return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.)),f.x),f.y);}
      float waves(vec2 p){float h=0.;float a=.48;for(int i=0;i<4;i++){h+=noise(p)*a;p=mat2(1.6,1.2,-1.2,1.6)*p+time*.016;a*=.5;}return h;}
      void main(){vec2 p=vWorld.xz-center;float d=length(p);float coast=1.-smoothstep(radius*.65,radius*1.55,d);
      vec2 moving=p*1.55+vec2(time*.022,-time*.034);float height=waves(moving);float e=.035;
      vec3 n=normalize(vec3((height-waves(moving+vec2(e,0.)))*2.7,.42,(height-waves(moving+vec2(0.,e)))*2.7));
      vec3 eye=normalize(cameraPosition-vWorld),sun=normalize(vec3(-.5,.7,.5));float fresnel=pow(1.-max(dot(eye,n),0.),3.);
      vec3 col=mix(vec3(.025,.085,.115),vec3(.07,.225,.245),coast*.75);col+=height*.016;
      col=mix(col,vec3(.21,.28,.28),fresnel*.35);float shine=pow(max(dot(n,normalize(sun+eye)),0.),115.);
      col+=vec3(.95,.70,.36)*shine*.28;gl_FragColor=vec4(col,1.);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      }`,
    });
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), waterMaterial);
    sea.rotation.x = -Math.PI / 2;
    sea.position.y = -0.15;
    scene.add(sea);
    const terrainTargets: THREE.Object3D[] = [];
    for (const hex of board.hexes) {
      const tile = new THREE.Group();
      tile.position.set(hex.x, 0, hex.z);
      island.add(tile);
      const points = hex.vertices
        .map((id) => board.vertices.find((v) => v.id === id)!)
        .map((v) => ({ x: v.x - hex.x, z: v.z - hex.z }));
      const mesh = sculptedHex(tile, points, hex.terrain, terrainSurfaces, hex.id + 117);
      mesh.userData.hit = {
        kind: 'hex',
        id: hex.id,
        label: `${TERRAIN[hex.terrain].label}${hex.number ? ` · ${hex.number}` : ''}`,
        actionable: false,
      } satisfies Hit;
      terrainTargets.push(mesh);
      decorateRealTerrain(tile, hex.terrain, hex.id + 117, terrainSurfaces);
      if (hex.number) {
        const token = labelSprite(
          String(hex.number),
          '',
          [6, 8].includes(hex.number) ? '#b74e3c' : '#3d4a3d',
        );
        token.position.set(0, 0.2, 0.05);
        tile.add(token);
      }
    }
    // Pale waterline follows the actual island boundary, including the extended board.
    const shoreMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { time: waterMaterial.uniforms.time },
      vertexShader:
        'varying vec2 vUv; varying vec3 world; void main(){ vUv=uv;vec4 p=modelMatrix*vec4(position,1.);world=p.xyz;gl_Position=projectionMatrix*viewMatrix*p;}',
      fragmentShader: `uniform float time; varying vec2 vUv; varying vec3 world; void main(){
        float wash=.5+.5*sin(vUv.x*41.+sin(world.x*11.)+time*.55);float broken=smoothstep(.25,.83,wash);
        float edge=pow(max(0.,1.-abs(vUv.y-.5)*2.),2.);float ends=smoothstep(0.,.12,vUv.x)*smoothstep(0.,.12,1.-vUv.x);
        gl_FragColor=vec4(.69,.77,.70,broken*edge*ends*.22); }`,
    });
    for (const edge of board.edges) {
      const a = board.vertices.find((v) => v.id === edge.a)!,
        b = board.vertices.find((v) => v.id === edge.b)!;
      if (a.hexes.filter((h) => b.hexes.includes(h)).length !== 1) continue;
      const mid = new THREE.Vector3((a.x + b.x) / 2, 0, (a.z + b.z) / 2);
      const outward = new THREE.Vector3(mid.x - center.x, 0, mid.z - center.z).normalize();
      const line = new THREE.Mesh(
        new THREE.PlaneGeometry(Math.hypot(a.x - b.x, a.z - b.z) * 0.96, 0.045),
        shoreMaterial,
      );
      line.rotation.x = -Math.PI / 2;
      line.rotation.z = -Math.atan2(b.z - a.z, b.x - a.x);
      line.position.set(mid.x + outward.x * 0.09, -0.138, mid.z + outward.z * 0.09);
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
        -0.137,
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

  const solidLayout = [
    state.robberHex,
    state.players.map((player) => player.color).join(','),
    state.board.edges.map((edge) => edge.owner ?? '-').join(','),
    state.board.vertices
      .map((vertex) => (vertex.building ? `${vertex.building.owner}:${vertex.building.type}` : '-'))
      .join(','),
  ].join('|');
  const placementLayout = `${buildKind}:${interactive}:${state.currentPlayer}:${state.phase === 'robber'}:${legalIds.join(',')}`;
  const lastShadowLayout = useRef('');
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
    // Timber framing, roof tiles and windows remain detailed but share a draw
    // call by material. Pulsing placement rings retain their own animation.
    const batchedPieces = batchStaticMeshes(ref.pieces, new Set(ref.pulse));
    ref.renderer.domElement.dataset.pieceMeshesBefore = String(batchedPieces.before);
    ref.renderer.domElement.dataset.pieceMeshesAfter = String(batchedPieces.after);
    if (lastShadowLayout.current !== solidLayout) {
      ref.renderer.shadowMap.needsUpdate = true;
      lastShadowLayout.current = solidLayout;
    }
  }, [solidLayout, placementLayout, topology]);

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
      mat.map?.uuid,
      mat.bumpMap?.uuid,
      mat.bumpScale,
      mat.vertexColors,
      mat.customProgramCacheKey(),
      object.renderOrder,
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
    merged.renderOrder = meshes[0].renderOrder;
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
