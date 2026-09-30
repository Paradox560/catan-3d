import * as THREE from 'three';
import type { Terrain } from '../game/types';

export type TerrainMaterials = Record<Terrain, THREE.MeshStandardMaterial>;
const BASE: Record<Terrain, string> = {
  wood: '#5a6240',
  sheep: '#899153',
  wheat: '#b29b52',
  brick: '#9d654c',
  ore: '#87837a',
  desert: '#c9b184',
};
const SWATCH: Record<Terrain, [number, number]> = {
  wood: [0, 1],
  sheep: [1, 1],
  wheat: [2, 1],
  brick: [0, 0],
  ore: [1, 0],
  desert: [2, 0],
};
export function seeded(seed: number) {
  let n = seed >>> 0;
  return () => {
    n = (Math.imul(1664525, n) + 1013904223) >>> 0;
    return n / 4294967296;
  };
}
function mat(color: THREE.ColorRepresentation, options: THREE.MeshStandardMaterialParameters = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.92, ...options });
}
function mesh(
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  x = 0,
  y = 0,
  z = 0,
) {
  const object = new THREE.Mesh(geometry, material);
  object.position.set(x, y, z);
  object.castShadow = true;
  object.receiveShadow = true;
  parent.add(object);
  return object;
}
function cube(
  parent: THREE.Object3D,
  material: THREE.Material,
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  d: number,
) {
  return mesh(parent, new THREE.BoxGeometry(w, h, d), material, x, y, z);
}
function branch(
  parent: THREE.Object3D,
  material: THREE.Material,
  a: THREE.Vector3,
  b: THREE.Vector3,
  radius: number,
  tip = radius * 0.6,
) {
  const direction = b.clone().sub(a);
  const object = mesh(
    parent,
    new THREE.CylinderGeometry(tip, radius, direction.length(), 7),
    material,
  );
  object.position.copy(a).add(b).multiplyScalar(0.5);
  object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  return object;
}
function noise(x: number, z: number, seed: number) {
  const lattice = (ix: number, iz: number) => {
    let n = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(seed, 1442695041);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
  };
  const value = (px: number, pz: number) => {
    const ix = Math.floor(px),
      iz = Math.floor(pz),
      fx = px - ix,
      fz = pz - iz;
    const u = fx * fx * (3 - 2 * fx),
      v = fz * fz * (3 - 2 * fz);
    return THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(lattice(ix, iz), lattice(ix + 1, iz), u),
      THREE.MathUtils.lerp(lattice(ix, iz + 1), lattice(ix + 1, iz + 1), u),
      v,
    );
  };
  return (
    value(x * 2.3, z * 2.3) * 0.65 +
    value(x * 5.1 + 17.4, z * 5.1 - 9.6) * 0.25 +
    value(x * 11.2 - 4.7, z * 11.2 + 21.3) * 0.1 -
    0.5
  );
}

/** Procedural fallback remains textured even when the optional art atlas is offline. */
export function createTerrainMaterials(onReady?: () => void): TerrainMaterials {
  const materials = {} as TerrainMaterials;
  for (const [index, terrain] of (Object.keys(BASE) as Terrain[]).entries()) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 512;
    const context = canvas.getContext('2d')!;
    const random = seeded(index * 391 + 19);
    const base = new THREE.Color(BASE[terrain]);
    const srgb = base.clone().convertLinearToSRGB();
    const pixels = context.createImageData(512, 512);
    for (let y = 0; y < 512; y++)
      for (let x = 0; x < 512; x++) {
        const f = 0.78 + random() * 0.28 + noise(x / 90, y / 90, index) * 0.19;
        const i = (y * 512 + x) * 4;
        // Canvas values are sRGB; conversion retains the intended earthy palette.
        pixels.data[i] = Math.min(255, srgb.r * 255 * f);
        pixels.data[i + 1] = Math.min(255, srgb.g * 255 * f);
        pixels.data[i + 2] = Math.min(255, srgb.b * 255 * f);
        pixels.data[i + 3] = 255;
      }
    context.putImageData(pixels, 0, 0);
    for (let i = 0; i < 2600; i++) {
      const x = random() * 512,
        y = random() * 512;
      context.strokeStyle = i % 3 ? '#d9cfaa25' : '#202b2520';
      context.lineWidth = random() * 1.7 + 0.4;
      context.beginPath();
      context.moveTo(x, y);
      context.lineTo(x + random() * 5 - 2, y + random() * 7);
      context.stroke();
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    materials[terrain] = mat('#ffffff', {
      map: texture,
      bumpMap: texture,
      bumpScale: terrain === 'ore' ? 0.045 : 0.018,
      side: THREE.DoubleSide,
    });
  }
  const leafCanvas = document.createElement('canvas');
  leafCanvas.width = leafCanvas.height = 128;
  const leafContext = leafCanvas.getContext('2d')!;
  leafContext.fillStyle = '#93967c';
  leafContext.fillRect(0, 0, 128, 128);
  const leafRandom = seeded(784);
  for (let i = 0; i < 1700; i++) {
    leafContext.fillStyle = ['#c8c9ac', '#6e755f', '#a6ac90', '#505b4933'][i % 4];
    leafContext.beginPath();
    leafContext.ellipse(
      leafRandom() * 128,
      leafRandom() * 128,
      1.2 + leafRandom() * 2,
      0.6 + leafRandom() * 1.4,
      leafRandom() * 6.3,
      0,
      6.3,
    );
    leafContext.fill();
  }
  const leafTexture = new THREE.CanvasTexture(leafCanvas);
  leafTexture.colorSpace = THREE.SRGBColorSpace;
  leafTexture.anisotropy = 4;
  materials.wood.userData.foliage = leafTexture;
  new THREE.TextureLoader().load(
    '/textures/terrain-atlas.png',
    (atlas) => {
      for (const terrain of Object.keys(BASE) as Terrain[]) {
        const texture = materials[terrain].map!;
        const [col, row] = SWATCH[terrain];
        const borderX = 5 / atlas.image.width,
          borderY = 5 / atlas.image.height;
        // WebGL2 texture storage has immutable dimensions. Release any uploaded
        // 512px fallback before replacing it with the larger atlas, while retaining
        // the same Texture and Source identities used by all terrain materials.
        texture.dispose();
        texture.image = atlas.image;
        texture.repeat.set(1 / 3 - borderX * 2, 1 / 2 - borderY * 2);
        texture.offset.set(col / 3 + borderX, row / 2 + borderY);
        texture.needsUpdate = true;
      }
      atlas.dispose();
      onReady?.();
    },
    undefined,
    () => {
      /* The generated procedural surfaces remain the fallback. */
    },
  );
  return materials;
}

export function sculptedHex(
  parent: THREE.Group,
  corners: { x: number; z: number }[],
  terrain: Terrain,
  materials: TerrainMaterials,
  seed: number,
) {
  const positions: number[] = [],
    uvs: number[] = [],
    indices: number[] = [];
  const segments = 60,
    rings = 10;
  const terrainHeight = (x: number, z: number, r: number) =>
    0.098 +
    noise(x, z, seed) * 0.014 * Math.sin(r * Math.PI) +
    (terrain === 'desert'
      ? Math.sin(x * 8 + z * 3) * 0.055 + Math.sin(x * 33 + z * 9) * 0.006
      : 0) *
      Math.sin(r * Math.PI);
  for (let ring = 0; ring <= rings; ring++)
    for (let i = 0; i < segments; i++) {
      const sector = Math.floor(i / 10),
        t = (i % 10) / 10,
        r = (ring / rings) * 0.982;
      const x = THREE.MathUtils.lerp(corners[sector].x, corners[(sector + 1) % 6].x, t) * r;
      const z = THREE.MathUtils.lerp(corners[sector].z, corners[(sector + 1) % 6].z, t) * r;
      positions.push(x, terrainHeight(x, z, r), z);
      uvs.push(x / 2 + 0.5, z / 2 + 0.5);
    }
  for (let ring = 0; ring < rings; ring++)
    for (let i = 0; i < segments; i++) {
      const a = ring * segments + i,
        b = ring * segments + ((i + 1) % segments),
        c = a + segments,
        d = b + segments;
      indices.push(a, b, c, b, d, c);
    }
  const topCount = indices.length;
  const soilStart = positions.length / 3;
  for (let i = 0; i < segments; i++) {
    const sector = Math.floor(i / 10),
      t = (i % 10) / 10;
    const x = THREE.MathUtils.lerp(corners[sector].x, corners[(sector + 1) % 6].x, t) * 0.982,
      z = THREE.MathUtils.lerp(corners[sector].z, corners[(sector + 1) % 6].z, t) * 0.982;
    positions.push(x, 0.098, z, x * 0.993, -0.17 + noise(x, z, seed) * 0.018, z * 0.993);
    uvs.push(x + 0.5, 1, x + 0.5, 0);
  }
  for (let i = 0; i < segments; i++) {
    const a = soilStart + i * 2,
      b = soilStart + ((i + 1) % segments) * 2;
    indices.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.addGroup(0, topCount, 0);
  geometry.addGroup(topCount, indices.length - topCount, 1);
  const rock = mat(terrain === 'desert' ? '#887754' : '#5c5342', {
    roughness: 1,
    side: THREE.DoubleSide,
    bumpMap: materials.ore.map,
    bumpScale: 0.055,
  });
  const tile = new THREE.Mesh(geometry, [materials[terrain], rock]);
  tile.castShadow = true;
  tile.receiveShadow = true;
  parent.add(tile);
  return tile;
}

function erodedRock(
  parent: THREE.Object3D,
  material: THREE.Material,
  random: () => number,
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
  detail = 1,
) {
  const geometry =
    detail > 0 ? new THREE.SphereGeometry(1, 14, 10) : new THREE.IcosahedronGeometry(1, 1);
  const p = geometry.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const vx = p.getX(i),
      vy = p.getY(i),
      vz = p.getZ(i);
    const displacement = 1 + Math.sin(vx * 8 + vy * 7) * Math.cos(vz * 9 - vy * 11) * 0.13;
    p.setXYZ(i, vx * displacement, vy * displacement, vz * displacement);
  }
  geometry.computeVertexNormals();
  const object = mesh(parent, geometry, material, x, y, z);
  object.scale.set(sx, sy, sz);
  object.rotation.y = random() * 6.28;
  return object;
}
function tree(
  parent: THREE.Object3D,
  random: () => number,
  x: number,
  z: number,
  h: number,
  evergreen: boolean,
  palettes: THREE.Material[],
) {
  const trunk = palettes[0];
  const lean = (random() - 0.5) * 0.07;
  branch(
    parent,
    trunk,
    new THREE.Vector3(x, 0.1, z),
    new THREE.Vector3(x + lean, 0.1 + h * 0.86, z),
    0.024,
    0.009,
  );
  if (evergreen) {
    for (let layer = 0; layer < 5; layer++) {
      const y = 0.18 + h * (0.14 + layer * 0.15),
        radius = h * (0.27 - layer * 0.044);
      for (let arm = 0; arm < 5; arm++) {
        const a = arm * 1.256 + layer * 0.71;
        const end = new THREE.Vector3(x + Math.cos(a) * radius, y - 0.04, z + Math.sin(a) * radius);
        branch(parent, trunk, new THREE.Vector3(x, y + 0.03, z), end, 0.009, 0.002);
        const leaves = erodedRock(
          parent,
          palettes[1 + ((arm + layer) % 3)],
          random,
          end.x * 0.68 + x * 0.32,
          y + 0.024,
          end.z * 0.68 + z * 0.32,
          radius * 0.65,
          radius * 0.42,
          radius * 0.53,
        );
        leaves.rotation.y = -a;
      }
    }
  } else {
    for (let arm = 0; arm < 5; arm++) {
      const a = arm * 1.256 + random() * 0.35;
      const radius = h * (0.2 + random() * 0.08),
        y = 0.1 + h * (0.59 + random() * 0.31);
      const end = new THREE.Vector3(x + Math.cos(a) * radius, y, z + Math.sin(a) * radius);
      branch(parent, trunk, new THREE.Vector3(x + lean / 2, 0.1 + h * 0.42, z), end, 0.014, 0.004);
      erodedRock(
        parent,
        palettes[1 + (arm % 3)],
        random,
        end.x,
        end.y,
        end.z,
        h * 0.22,
        h * 0.22,
        h * 0.2,
        1,
      );
      erodedRock(
        parent,
        palettes[1 + ((arm + 1) % 3)],
        random,
        end.x + 0.04,
        end.y + 0.06,
        end.z - 0.025,
        h * 0.145,
        h * 0.18,
        h * 0.16,
        1,
      );
    }
  }
}
function fence(parent: THREE.Object3D, timber: THREE.Material, width = 0.65) {
  for (let i = 0; i < 5; i++)
    cube(parent, timber, (i / 4 - 0.5) * width, 0.18, 0, 0.016, 0.17, 0.021);
  for (const y of [0.15, 0.22]) cube(parent, timber, 0, y, 0, width + 0.035, 0.012, 0.019);
}
function sheep(
  parent: THREE.Object3D,
  random: () => number,
  x: number,
  z: number,
  wool: THREE.Material,
  dark: THREE.Material,
) {
  const group = new THREE.Group();
  group.position.set(x, 0.1, z);
  group.rotation.y = random() * 6.28;
  parent.add(group);
  const body = mesh(group, new THREE.SphereGeometry(0.078, 10, 7), wool, 0, 0.098, 0);
  body.scale.set(1.48, 1, 0.89);
  for (let i = 0; i < 10; i++) {
    const a = i * 2.4;
    mesh(
      group,
      new THREE.SphereGeometry(0.025 + random() * 0.008, 5, 4),
      wool,
      Math.cos(a) * 0.067,
      0.1 + Math.sin(a) * 0.048,
      (random() - 0.5) * 0.11,
    );
  }
  const head = mesh(group, new THREE.SphereGeometry(0.03, 8, 6), dark, 0.112, 0.095, 0);
  head.scale.set(0.8, 1.24, 0.8);
  for (const side of [-1, 1]) {
    const ear = mesh(
      group,
      new THREE.SphereGeometry(0.023, 6, 4),
      wool,
      0.107,
      0.112,
      side * 0.033,
    );
    ear.scale.set(0.75, 0.3, 1);
  }
  for (const vx of [-0.052, 0.051])
    for (const vz of [-0.036, 0.036])
      branch(group, dark, new THREE.Vector3(vx, 0.018, vz), new THREE.Vector3(vx, 0.08, vz), 0.008);
}

export function decorateRealTerrain(
  group: THREE.Group,
  terrain: Terrain,
  seed: number,
  surfaces: TerrainMaterials,
) {
  const random = seeded(seed * 127 + 9381),
    bark = mat('#574431'),
    timber = mat('#8b7250'),
    stone = mat('#767569', { map: surfaces.ore.map, bumpMap: surfaces.ore.map, bumpScale: 0.03 });
  const grass = [mat('#58683a'), mat('#738044'), mat('#939057')];
  const leafMap = surfaces.wood.userData.foliage as THREE.Texture;
  const palettes = [
    bark,
    mat('#516544', { map: leafMap, bumpMap: leafMap, bumpScale: 0.01 }),
    mat('#61764b', { map: leafMap, bumpMap: leafMap, bumpScale: 0.01 }),
    mat('#7d8a59', { map: leafMap, bumpMap: leafMap, bumpScale: 0.01 }),
  ];
  const at = (angle: number, radius: number) => ({
    x: Math.cos(angle) * radius,
    z: Math.sin(angle) * radius,
  });
  if (terrain === 'wood') {
    for (let i = 0; i < 13; i++) {
      const p = at(i * 2.4 + 0.2, 0.45 + (i % 3) * 0.115);
      tree(group, random, p.x, p.z, 0.35 + random() * 0.36, i % 3 === 0, palettes);
    }
    for (let i = 0; i < 11; i++) {
      const p = at(i * 2.399, 0.45 + random() * 0.31);
      erodedRock(
        group,
        i % 3 === 0 ? stone : grass[i % 3],
        random,
        p.x,
        0.13,
        p.z,
        0.045,
        0.027,
        0.06,
      );
    }
    const log = mesh(
      group,
      new THREE.CylinderGeometry(0.037, 0.045, 0.28, 9),
      bark,
      0.45,
      0.15,
      0.2,
    );
    log.rotation.z = 1.42;
    log.rotation.y = 0.5;
  } else if (terrain === 'ore') {
    const rockMats = [
      mat('#c5c0b1', { map: surfaces.ore.map, bumpMap: surfaces.ore.map, bumpScale: 0.035 }),
      mat('#ddd2bc', { map: surfaces.ore.map, bumpMap: surfaces.ore.map, bumpScale: 0.03 }),
      mat('#aab0a6', { map: surfaces.ore.map, bumpMap: surfaces.ore.map, bumpScale: 0.03 }),
    ];
    // One continuous massif: offset peaks overlap into saddles and irregular ridges.
    const peaks = [
      { x: -0.4 + random() * 0.06, z: -0.19, h: 0.53 + random() * 0.12, width: 0.06 },
      { x: -0.13, z: -0.47 + random() * 0.05, h: 0.75 + random() * 0.12, width: 0.046 },
      { x: 0.26, z: -0.32, h: 0.6 + random() * 0.1, width: 0.058 },
      { x: 0.46, z: 0.04, h: 0.37 + random() * 0.1, width: 0.041 },
      { x: -0.53, z: 0.17, h: 0.22, width: 0.035 },
    ];
    const pos: number[] = [],
      uv: number[] = [],
      colors: number[] = [],
      snowCover: number[] = [],
      indices: number[] = [];
    const rings = 23,
      sectors = 72;
    for (let ring = 0; ring <= rings; ring++)
      for (let i = 0; i < sectors; i++) {
        const a = (i / sectors) * Math.PI * 2,
          r = ring / rings;
        const sector = Math.floor(i / 12),
          t = (i % 12) / 12;
        const ca = ((sector * 60 - 30) * Math.PI) / 180,
          cb = (((sector + 1) * 60 - 30) * Math.PI) / 180;
        const x = THREE.MathUtils.lerp(Math.cos(ca), Math.cos(cb), t) * r * 0.92;
        const z = THREE.MathUtils.lerp(Math.sin(ca), Math.sin(cb), t) * r * 0.92;
        const heights = peaks.map(
          (p) => p.h * Math.exp(-((x - p.x) ** 2 + (z - p.z) ** 2) / p.width),
        );
        heights.sort((left, right) => right - left);
        const erosion = noise(x * 3.2, z * 3.2, seed + 721) * 0.55;
        let h = (heights[0] + heights[1] * 0.27 + heights[2] * 0.08) * (1 + erosion);
        h += Math.abs(noise(x * 9 + a * 0.01, z * 9, seed)) * 0.09 * Math.min(1, h * 6);
        h *= THREE.MathUtils.smoothstep(1 - r, 0, 0.16);
        const clearing = THREE.MathUtils.smoothstep(Math.hypot(x, z), 0.13, 0.3);
        h *= 0.2 + clearing * 0.8;
        pos.push(x, h, z);
        uv.push(x / 2 + 0.5, z / 2 + 0.5);
        const snow = THREE.MathUtils.smoothstep(h + noise(x * 7, z * 7, seed) * 0.1, 0.56, 0.77);
        const color = new THREE.Color('#afa998').lerp(new THREE.Color('#fffbee'), snow);
        colors.push(color.r, color.g, color.b);
        snowCover.push(snow);
      }
    for (let ring = 0; ring < rings; ring++)
      for (let i = 0; i < sectors; i++) {
        const a = ring * sectors + i,
          b = ring * sectors + ((i + 1) % sectors),
          c = a + sectors,
          d = b + sectors;
        indices.push(a, b, c, b, d, c);
      }
    const ridgeGeometry = new THREE.BufferGeometry();
    ridgeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    ridgeGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    ridgeGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    ridgeGeometry.setAttribute('snow', new THREE.Float32BufferAttribute(snowCover, 1));
    ridgeGeometry.setIndex(indices);
    ridgeGeometry.computeVertexNormals();
    const ridgeMaterial = mat('#ffffff', {
      map: surfaces.ore.map,
      bumpMap: surfaces.ore.map,
      bumpScale: 0.024,
      vertexColors: true,
    });
    ridgeMaterial.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nattribute float snow; varying float vSnow;',
        )
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSnow = snow;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vSnow;')
        .replace(
          '#include <map_fragment>',
          '#include <map_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(.76, .75, .69), vSnow);',
        );
    };
    ridgeMaterial.customProgramCacheKey = () => 'snow-capped-ridge-v1';
    mesh(group, ridgeGeometry, ridgeMaterial, 0, 0.105, 0);
    for (let i = 0; i < 15; i++) {
      const p = at(random() * 6.28, 0.42 + random() * 0.34);
      erodedRock(
        group,
        rockMats[i % 3],
        random,
        p.x,
        0.13,
        p.z,
        0.025 + random() * 0.045,
        0.025,
        0.038,
      );
    }
    const mine = new THREE.Group();
    mine.position.set(-0.52, 0.11, 0.3);
    mine.rotation.y = -0.6;
    group.add(mine);
    cube(mine, mat('#242b27'), 0, 0.074, 0, 0.17, 0.15, 0.025);
    for (const x of [-0.092, 0.092]) cube(mine, timber, x, 0.08, 0.027, 0.024, 0.17, 0.035);
    cube(mine, timber, 0, 0.17, 0.027, 0.21, 0.035, 0.04);
    for (const x of [-0.046, 0.046]) cube(mine, mat('#696257'), x, 0.018, 0.13, 0.01, 0.01, 0.27);
  } else if (terrain === 'sheep') {
    for (let i = 0; i < 5; i++) {
      const p = at(i * 1.29 + 0.3, 0.52 + random() * 0.12);
      sheep(group, random, p.x, p.z, mat('#d8d2bd'), mat('#45443b'));
    }
    for (let i = 0; i < 65; i++) {
      const p = at(i * 2.39, 0.37 + random() * 0.39);
      const blade = mesh(
        group,
        new THREE.ConeGeometry(0.013, 0.04 + random() * 0.035, 3),
        grass[i % 3],
        p.x,
        0.126,
        p.z,
      );
      blade.rotation.z = (random() - 0.5) * 0.7;
    }
    const hedgerow = new THREE.Group();
    hedgerow.position.set(0, 0, 0.71);
    hedgerow.rotation.y = -0.12;
    group.add(hedgerow);
    fence(hedgerow, timber, 0.65);
    tree(group, random, -0.63, -0.13, 0.37, false, palettes);
    for (let i = 0; i < 7; i++)
      erodedRock(
        group,
        stone,
        random,
        -0.7 + i * 0.035,
        0.118,
        0.25 + i * 0.07,
        0.035,
        0.024,
        0.031,
      );
  } else if (terrain === 'wheat') {
    const stalk = mat('#ae9147'),
      ear = mat('#d0b469'),
      soil = mat('#7e6a42');
    const field = new THREE.Group();
    field.rotation.y = -0.35;
    group.add(field);
    for (const side of [-1, 1])
      for (let row = 0; row < 5; row++) {
        const z = side * (0.33 + row * 0.082),
          length = 0.9 - row * 0.095;
        cube(field, soil, 0, 0.1, z, length, 0.009, 0.027);
        for (let col = 0; col < 13 - row; col++) {
          const x = (col / (12 - row) - 0.5) * length,
            height = 0.08 + random() * 0.055;
          branch(
            field,
            stalk,
            new THREE.Vector3(x, 0.103, z),
            new THREE.Vector3(x + 0.012, 0.11 + height, z),
            0.003,
            0.0015,
          );
          const head = mesh(
            field,
            new THREE.SphereGeometry(0.012, 5, 4),
            ear,
            x + 0.012,
            0.12 + height,
            z,
          );
          head.scale.set(0.7, 1.9, 0.65);
        }
      }
    const mill = new THREE.Group();
    mill.position.set(0.63, 0.1, 0.1);
    mill.rotation.y = -0.25;
    mill.scale.setScalar(0.75);
    group.add(mill);
    mesh(mill, new THREE.CylinderGeometry(0.068, 0.105, 0.29, 12), mat('#bbae89'), 0, 0.145, 0);
    mesh(mill, new THREE.ConeGeometry(0.1, 0.13, 12), mat('#675541'), 0, 0.345, 0);
    cube(mill, bark, 0, 0.25, 0.079, 0.025, 0.025, 0.058);
    for (let i = 0; i < 4; i++) {
      const vane = new THREE.Group();
      vane.position.set(0, 0.25, 0.116);
      vane.rotation.z = (i * Math.PI) / 2 + 0.3;
      mill.add(vane);
      cube(vane, timber, 0, 0.107, 0, 0.011, 0.24, 0.012);
      for (let j = 0; j < 6; j++)
        cube(vane, mat('#c2b595'), 0.023, 0.055 + j * 0.029, 0, 0.055, 0.014, 0.007);
    }
    const bale = mesh(
      group,
      new THREE.CylinderGeometry(0.058, 0.058, 0.14, 12),
      ear,
      -0.62,
      0.16,
      0.02,
    );
    bale.rotation.z = Math.PI / 2;
    for (const x of [-0.66, -0.58]) {
      const band = mesh(group, new THREE.TorusGeometry(0.059, 0.004, 4, 12), bark, x, 0.16, 0.02);
      band.rotation.y = Math.PI / 2;
    }
  } else if (terrain === 'brick') {
    const clay = [
      mat('#d4b497', { map: surfaces.brick.map, bumpMap: surfaces.brick.map, bumpScale: 0.025 }),
      mat('#89583e'),
      mat('#b88761'),
    ];
    const bank = new THREE.Group();
    bank.rotation.y = (random() - 0.5) * 0.55;
    bank.scale.y = 0.86 + random() * 0.28;
    group.add(bank);
    const outline = [
      [-0.71, -0.12],
      [-0.68, -0.38],
      [-0.39, -0.68],
      [-0.08, -0.77],
      [0.23, -0.66],
      [0.52, -0.42],
      [0.61, -0.14],
      [0.35, -0.04],
      [0.21, -0.21],
      [-0.1, -0.3],
      [-0.35, -0.1],
    ];
    for (let level = 0; level < 4; level++) {
      const shape = new THREE.Shape();
      outline.forEach(([x, z], i) => {
        const px = x * (1 - level * 0.09) + noise(i, level, seed) * 0.035,
          pz = z * (1 - level * 0.045) - level * 0.045;
        if (i === 0) shape.moveTo(px, -pz);
        else shape.lineTo(px, -pz);
      });
      shape.closePath();
      const geometry = new THREE.ExtrudeGeometry(shape, {
        depth: 0.069 + (level === 0 ? 0.02 : 0),
        bevelEnabled: false,
        curveSegments: 1,
      });
      const uv = geometry.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) + 1) / 2, (uv.getY(i) + 1) / 2);
      const layer = mesh(
        bank,
        geometry,
        clay[level === 3 ? 0 : 1 + (level % 2)],
        0,
        0.105 + level * 0.073,
        0,
      );
      layer.rotation.x = -Math.PI / 2;
    }
    for (let j = 0; j < 12; j++)
      erodedRock(
        group,
        clay[j % 3],
        random,
        -0.58 + random() * 0.38,
        0.12,
        0.05 + random() * 0.27,
        0.027 + random() * 0.025,
        0.019,
        0.035,
        0,
      );
    const brickMat = mat('#9f563e');
    for (let row = 0; row < 3; row++)
      for (let col = 0; col < 4 - row; col++)
        cube(
          group,
          brickMat,
          -0.21 + col * 0.1 + row * 0.045,
          0.13 + row * 0.045,
          0.66,
          0.093,
          0.039,
          0.065,
        );
    const cart = new THREE.Group();
    cart.position.set(0.58, 0.14, -0.13);
    cart.rotation.y = 0.45;
    group.add(cart);
    cube(cart, timber, 0, 0.048, 0, 0.15, 0.022, 0.19);
    for (const x of [-0.08, 0.08]) cube(cart, timber, x, 0.09, 0, 0.016, 0.08, 0.19);
    for (const x of [-0.1, 0.1]) {
      const wheel = mesh(cart, new THREE.TorusGeometry(0.045, 0.008, 5, 12), bark, x, 0.025, 0);
      wheel.rotation.y = Math.PI / 2;
      cube(cart, bark, x, 0.026, 0, 0.012, 0.086, 0.008);
    }
    for (const x of [-0.05, 0.05]) cube(cart, bark, x, 0.028, -0.2, 0.011, 0.011, 0.22);
  } else {
    for (let palm = 0; palm < 2; palm++) {
      const x = -0.52 + palm * 0.19,
        z = 0.31 - palm * 0.09,
        height = 0.32 + palm * 0.13;
      branch(
        group,
        timber,
        new THREE.Vector3(x, 0.12, z),
        new THREE.Vector3(x + 0.045, 0.12 + height, z),
        0.018,
        0.011,
      );
      for (let i = 0; i < 7; i++) {
        const a = i * 0.9;
        const end = new THREE.Vector3(
          x + 0.045 + Math.cos(a) * 0.19,
          0.1 + height - 0.02,
          z + Math.sin(a) * 0.19,
        );
        branch(
          group,
          palettes[2],
          new THREE.Vector3(x + 0.045, 0.12 + height, z),
          end,
          0.019,
          0.002,
        );
      }
    }
    const ruins = mat('#a69575');
    for (let row = 0; row < 3; row++)
      for (let i = 0; i < 4 - row; i++) {
        const block = cube(
          group,
          ruins,
          0.37 + i * 0.072 + row * 0.025,
          0.127 + row * 0.048,
          -0.4,
          0.067,
          0.043,
          0.075,
        );
        block.rotation.y = random() * 0.12;
      }
    mesh(group, new THREE.CylinderGeometry(0.046, 0.055, 0.23, 10), ruins, 0.37, 0.22, -0.58);
  }
}

export function medievalBuilding(
  parent: THREE.Group,
  type: 'settlement' | 'city',
  color: string,
  x: number,
  z: number,
) {
  const group = new THREE.Group();
  group.position.set(x, 0.105, z);
  group.rotation.y = Math.PI / 6;
  parent.add(group);
  const plaster = mat('#d9cdb0'),
    wood = mat('#574432'),
    stone = mat('#908778'),
    roof = mat(new THREE.Color(color).lerp(new THREE.Color('#654634'), 0.43)),
    dark = mat('#282b26'),
    light = mat('#e4b962');
  // Heraldic base and roof colors keep ownership clear amid natural materials.
  cube(
    group,
    mat(color),
    0,
    0.015,
    0,
    type === 'city' ? 0.39 : 0.25,
    0.026,
    type === 'city' ? 0.33 : 0.235,
  );
  function house(px: number, pz: number, scale: number, height: number) {
    const house = new THREE.Group();
    house.position.set(px, 0.026, pz);
    house.scale.setScalar(scale);
    group.add(house);
    cube(house, stone, 0, 0.033, 0, 0.214, 0.066, 0.187);
    cube(house, plaster, 0, height / 2 + 0.055, 0, 0.2, height, 0.17);
    for (const vx of [-0.099, 0, 0.099])
      cube(house, wood, vx, height / 2 + 0.055, 0.088, 0.01, height, 0.008);
    for (const vy of [0.06, height * 0.54 + 0.055, height + 0.055])
      cube(house, wood, 0, vy, 0.088, 0.21, 0.01, 0.008);
    for (const vx of [-0.102, 0.102]) {
      cube(house, wood, vx, height / 2 + 0.055, -0.079, 0.01, height, 0.012);
      cube(house, wood, vx, height * 0.54 + 0.055, 0, 0.009, 0.01, 0.17);
    }
    const shape = new THREE.Shape();
    shape.moveTo(-0.131, 0);
    shape.lineTo(0.131, 0);
    shape.lineTo(0, 0.116);
    shape.closePath();
    mesh(
      house,
      new THREE.ExtrudeGeometry(shape, { depth: 0.214, bevelEnabled: false }),
      roof,
      0,
      height + 0.06,
      -0.107,
    );
    for (let row = 0; row < 4; row++) {
      const slopeY = height + 0.064 + row * 0.027;
      for (const side of [-1, 1]) {
        const trim = cube(
          house,
          roof,
          side * (0.122 - row * 0.029),
          slopeY,
          0,
          0.014,
          0.012,
          0.223,
        );
        trim.rotation.z = side * -0.69;
      }
    }
    cube(house, wood, -0.027, 0.099, 0.092, 0.05, 0.095, 0.007);
    cube(house, dark, -0.027, 0.101, 0.097, 0.034, 0.084, 0.003);
    for (const vx of [-0.053, 0.053]) {
      cube(house, dark, vx, height * 0.68 + 0.058, 0.095, 0.036, 0.042, 0.005);
      cube(house, light, vx, height * 0.68 + 0.058, 0.099, 0.021, 0.029, 0.003);
      cube(house, wood, vx, height * 0.68 + 0.058, 0.102, 0.004, 0.033, 0.004);
    }
    cube(house, stone, 0.061, height + 0.154, -0.041, 0.035, 0.133, 0.036);
    cube(house, dark, 0.061, height + 0.224, -0.041, 0.04, 0.01, 0.041);
  }
  if (type === 'settlement') house(0, 0, 1, 0.2);
  else {
    house(-0.075, 0.032, 0.85, 0.24);
    house(0.088, 0.035, 0.72, 0.19);
    const keep = mesh(
      group,
      new THREE.CylinderGeometry(0.065, 0.073, 0.35, 10),
      stone,
      -0.105,
      0.19,
      -0.1,
    );
    keep.rotation.y = 0.16;
    mesh(group, new THREE.ConeGeometry(0.091, 0.14, 10), roof, -0.105, 0.432, -0.1);
    cube(group, stone, 0.054, 0.11, -0.108, 0.2, 0.21, 0.057);
    for (let i = 0; i < 5; i++)
      cube(group, stone, -0.033 + i * 0.045, 0.239, -0.108, 0.027, 0.052, 0.059);
    for (let i = 0; i < 3; i++)
      cube(group, dark, -0.1 + i * 0.038, 0.26, -0.035, 0.012, 0.049, 0.004);
  }
  branch(
    group,
    wood,
    new THREE.Vector3(0.1, 0.06, -0.085),
    new THREE.Vector3(0.1, type === 'city' ? 0.5 : 0.39, -0.085),
    0.005,
    0.004,
  );
  cube(
    group,
    mat(color, { side: THREE.DoubleSide }),
    0.139,
    type === 'city' ? 0.463 : 0.355,
    -0.085,
    0.075,
    0.052,
    0.005,
  );
  return group;
}
