import * as THREE from './vendor/three.module.min.js';
import { UNITS, WALL_LENGTH } from './world.mjs';

const palette = {
  steel: '#70818a', dark: '#263942', shell: '#c2cccf',
  cyan: '#83e6f4', amber: '#e7ad63', panel: '#265a79', tread: '#1d2e32',
};
const materials = new Map();
const geometries = new Map();
const buildings = new Map();
const units = new Map();
const fallenUnits = new Map();
const unitAssets = new Map();
const UNIT_MODELS_URL = new URL('./assets/models/units.json', import.meta.url).href;
const unitBody = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.76, flatShading: true });
const unitLights = new THREE.MeshBasicMaterial({ vertexColors: true });
const wreckBody = new THREE.MeshStandardMaterial({ color: '#97827a', vertexColors: true, roughness: 0.97, flatShading: true });

export async function loadUnitModels() {
  try {
    const response = await fetch(UNIT_MODELS_URL);
    if (!response.ok) throw new Error(`Unit model request returned ${response.status}`);
    const loader = new THREE.BufferGeometryLoader();
    const assets = Object.entries(await response.json()).map(([type, meshes]) => [type, meshes.map((part) => {
      const geometry = loader.parse(part);
      geometry.computeVertexNormals();
      return { name: part.name, origin: part.origin, geometry };
    })]);
    for (const [type, meshes] of assets) unitAssets.set(type, meshes);
  } catch (error) {
    console.warn('The Blender units could not load. Using the original models.', error);
  }
}

function indexedGeometry(points, triangles) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points.flat(), 3));
  geometry.setIndex(triangles);
  geometry.computeVertexNormals();
  return geometry;
}

function casingGeometry() {
  const outline = [[-0.36, -0.5], [0.36, -0.5], [0.5, -0.36], [0.5, 0.36],
    [0.36, 0.5], [-0.36, 0.5], [-0.5, 0.36], [-0.5, -0.36]];
  const points = [[-0.5, 1], [0.34, 1], [0.5, 0.86]]
    .flatMap(([y, scale]) => outline.map(([x, z]) => [x * scale, y, z * scale]));
  const triangles = [];
  for (let level = 0; level < 2; level++) {
    for (let side = 0; side < 8; side++) {
      const a = level * 8 + side;
      const b = level * 8 + (side + 1) % 8;
      triangles.push(a, a + 8, b, b, a + 8, b + 8);
    }
  }
  for (let side = 1; side < 7; side++) triangles.push(0, side, side + 1, 16, 17 + side, 16 + side);
  return indexedGeometry(points, triangles);
}

const geometryFactories = {
  box: () => new THREE.BoxGeometry(1, 1, 1),
  plate: () => new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
  casing: casingGeometry,
  sphere: () => new THREE.DodecahedronGeometry(0.5, 0),
  round: () => new THREE.IcosahedronGeometry(0.5, 1),
  drum: () => new THREE.CylinderGeometry(0.5, 0.5, 1, 16),
  fitting: () => new THREE.CylinderGeometry(0.5, 0.5, 1, 8),
  band: () => new THREE.CylinderGeometry(0.5, 0.5, 1, 16, 1, true),
  cone: () => new THREE.ConeGeometry(0.5, 1, 12),
  shard: () => new THREE.CylinderGeometry(0.05, 0.5, 1, 10),
  dish: () => new THREE.LatheGeometry([new THREE.Vector2(0, 0), new THREE.Vector2(0.18, 0.019),
    new THREE.Vector2(0.33, 0.065), new THREE.Vector2(0.43, 0.12), new THREE.Vector2(0.49, 0.20)], 24),
  gable: () => indexedGeometry([[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0, 0.5, -0.5],
    [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0, 0.5, 0.5]], [0, 2, 1, 3, 4, 5, 0, 3, 5, 0, 5, 2,
    2, 5, 4, 2, 4, 1, 0, 1, 4, 0, 4, 3]),
  leaf: () => indexedGeometry([[0, -0.18, -0.5], [-0.5, 0.07, 0.02], [0, 0.32, 0.5], [0.5, 0.07, 0.02], [0, 0.34, -0.02]],
    [0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4]),
};

export function material(color, emissive = false) {
  const key = `${color}/${emissive}`;
  if (!materials.has(key)) materials.set(key, emissive
    ? new THREE.MeshBasicMaterial({ color })
    : new THREE.MeshStandardMaterial({ color, roughness: 0.77, flatShading: true }));
  return materials.get(key);
}

export function primitive(group, type, color, x, y, z, sx, sy, sz, emissive = false) {
  if (!geometries.has(type)) geometries.set(type, geometryFactories[type]());
  const mesh = new THREE.Mesh(geometries.get(type), material(color, emissive));
  mesh.position.set(x, y, z);
  mesh.scale.set(sx, sy, sz);
  group.add(mesh);
  return mesh;
}

function mergeParts(parts) {
  const positions = [];
  const normals = [];
  const indices = [];
  const vertex = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();
  for (const part of parts) {
    part.updateMatrix();
    normalMatrix.getNormalMatrix(part.matrix);
    const offset = positions.length / 3;
    const { position, normal } = part.geometry.attributes;
    for (let index = 0; index < position.count; index++) {
      vertex.fromBufferAttribute(position, index).applyMatrix4(part.matrix);
      positions.push(vertex.x, vertex.y, vertex.z);
      vertex.fromBufferAttribute(normal, index).applyNormalMatrix(normalMatrix);
      normals.push(vertex.x, vertex.y, vertex.z);
    }
    const meshIndices = part.geometry.index;
    for (let index = 0; index < (meshIndices?.count ?? position.count); index++) {
      indices.push(offset + (meshIndices ? meshIndices.getX(index) : index));
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  return geometry;
}

// Keep moving subassemblies separate and reuse the packed geometry across instances.
function packModel(group) {
  const materialsInGroup = new Map();
  for (const child of group.children) {
    if (child.isGroup) packModel(child);
    if (!child.isMesh || child.name || !child.visible) continue;
    if (!materialsInGroup.has(child.material)) materialsInGroup.set(child.material, []);
    materialsInGroup.get(child.material).push(child);
  }
  for (const [material, parts] of materialsInGroup) {
    if (parts.length < 2) continue;
    group.add(new THREE.Mesh(mergeParts(parts), material));
    group.remove(...parts);
  }
  return group;
}

function modelInstance(cache, factory, type) {
  if (!cache.has(type)) cache.set(type, packModel(factory(type)));
  return cache.get(type).clone(true);
}

export function buildingModel(type) {
  const model = modelInstance(buildings, makeBuildingModel, type);
  if (type === 'uplink') {
    for (const part of ['dish', 'rocket', 'exhaust']) model.userData[part] = model.getObjectByName(part);
  }
  return model;
}

export function unitModel(type) {
  const model = modelInstance(units, makeUnitModel, type);
  if (type === 'reptile' || type === 'ancient') model.userData.tail = model.getObjectByName('tail');
  if (UNITS[type]?.combat?.shell) model.userData.turret = model.getObjectByName('turret');
  return model;
}

export function fallenUnitModel(type) {
  if (!fallenUnits.has(type)) {
    const group = new THREE.Group();
    const body = unitModel(type);
    delete body.userData.tail;
    delete body.userData.turret;
    const chassis = UNITS[type]?.model ?? type;
    if (chassis === 'infantry') body.rotation.x = Math.PI / 2;
    else if (chassis === 'reptile' || chassis === 'ancient') body.rotation.z = 1.1;
    else {
      body.rotation.z = -0.58;
      body.scale.y *= 0.57;
    }
    const soot = new THREE.Color('#423a3c');
    body.traverse((part) => {
      if (!part.isMesh) return;
      if (part.material.vertexColors) {
        part.material = wreckBody;
        return;
      }
      const color = part.material.color.clone().lerp(soot, 0.7).multiplyScalar(0.74);
      part.material = material(`#${color.getHexString()}`);
    });
    body.position.y = 0.05 - new THREE.Box3().setFromObject(body, true).min.y;
    group.add(body);
    fallenUnits.set(type, group);
  }
  return fallenUnits.get(type).clone(true);
}

function farmModel(group) {
  const box = (...args) => primitive(group, 'box', ...args);
  const { dark, steel, shell } = palette;
  box('#443329', 0, 0.09, 0, 2.22, 0.20, 2.15);
  box('#654735', 0, 0.20, 0, 2.08, 0.10, 2.01);
  for (const z of [-1.02, 1.02]) box('#a28c67', 0, 0.22, z, 2.22, 0.12, 0.067);
  for (const x of [-1.09, 1.09]) box('#a28c67', x, 0.22, 0, 0.065, 0.12, 2.08);

  const crops = [
    { x: -0.71, leaf: '#6e9749', tip: '#a7c56b' },
    { x: -0.21, leaf: '#527d46', tip: '#80a852' },
    { x: 0.29, leaf: '#789547', tip: '#c6c36d' },
  ];
  for (const [row, { x, leaf, tip }] of crops.entries()) {
    primitive(group, 'casing', '#805a3d', x, 0.245, 0.21, 0.37, 0.14, 1.41);
    box('#533e30', x - 0.20, 0.255, 0.20, 0.041, 0.020, 1.38);
    for (let plant = 0; plant < 5; plant++) {
      const z = -0.34 + plant * 0.265;
      for (let side = 0; side < 4; side++) {
        const angle = side * Math.PI / 2 + plant * 0.63 + row * 0.48;
        const height = 0.10 + ((plant + row * 3) % 4) * 0.025;
        const blade = primitive(group, 'leaf', side % 2 ? leaf : tip, x + Math.sin(angle) * 0.045, 0.31, z + Math.cos(angle) * 0.045,
          0.14, height * 2.4, 0.23);
        blade.rotation.y = angle;
      }
    }
  }
  box(steel, -0.38, 0.27, -0.62, 1.38, 0.045, 0.045);
  for (const { x } of crops) box(steel, x, 0.27, -0.52, 0.038, 0.042, 0.27);
  primitive(group, 'drum', '#71979d', -0.75, 0.415, -0.76, 0.35, 0.31, 0.35);
  primitive(group, 'drum', shell, -0.75, 0.58, -0.76, 0.31, 0.048, 0.31);
  box('#988160', 0.58, 0.41, -0.68, 0.71, 0.36, 0.53);
  primitive(group, 'gable', '#cdbb89', 0.58, 0.67, -0.68, 0.83, 0.21, 0.62);
  box(dark, 0.58, 0.42, -0.405, 0.21, 0.25, 0.024);
  box('#daaa56', 0.82, 0.31, 0.77, 0.29, 0.18, 0.26);
  box('#765635', 0.82, 0.411, 0.77, 0.23, 0.024, 0.19);
  return group;
}

function foundryModel(group) {
  const box = (...args) => primitive(group, 'box', ...args);
  const casing = (...args) => primitive(group, 'casing', ...args);
  const drum = (...args) => primitive(group, 'drum', ...args);
  const plinth = '#252e3a';
  const armor = '#414c60';
  const rib = '#5d6b7d';
  const trim = '#8f9da9';
  const recess = '#151c29';
  const signal = '#c9adff';
  const hazard = '#d9a36b';

  casing(plinth, 0, 0.13, -0.08, 2.92, 0.28, 2.64);
  casing(rib, 0, 0.30, -0.20, 2.76, 0.16, 2.34);
  casing(armor, 0, 1.04, -0.86, 2.42, 1.47, 0.90);
  box(recess, 0, 0.95, -0.388, 1.53, 1.24, 0.065);
  casing(plinth, 0, 0.16, 1.05, 1.75, 0.18, 1.45).rotation.x = 0.10;
  box(recess, 0, 0.326, 0.24, 1.47, 0.06, 1.87);

  for (const side of [-1, 1]) {
    casing(armor, side * 1.06, 0.99, 0.00, 0.62, 1.50, 2.14);
    casing(rib, side * 1.19, 1.00, 0.23, 0.50, 1.47, 1.60);
    casing(trim, side * 1.11, 1.13, 0.91, 0.40, 0.88, 0.25);
    box(armor, side * 1.438, 0.91, -0.02, 0.038, 0.46, 1.02);
    for (const z of [-0.38, -0.14, 0.10, 0.34]) {
      box(plinth, side * 1.465, 0.91, z, 0.044, 0.34, 0.13);
      box(rib, side * 1.489, 0.995, z, 0.021, 0.08, 0.13);
    }
    box(trim, side * 0.62, 0.35, 0.36, 0.071, 0.043, 2.43);
    box(hazard, side * 0.76, 0.289, 1.16, 0.082, 0.035, 0.46, true).rotation.x = 0.10;
    box(signal, side * 0.913, 1.25, 1.043, 0.07, 0.32, 0.029, true);
    for (const z of [1.10, 1.27, 1.44]) {
      box(hazard, side * 0.38, 0.247 - (z - 1.10) * 0.10, z, 0.23, 0.018, 0.049).rotation.y = side * 0.48;
    }
  }

  casing(armor, 0, 1.74, -0.05, 2.75, 0.48, 2.09);
  casing(rib, 0, 2.00, -0.24, 2.26, 0.20, 1.68);
  casing(plinth, 0, 2.16, -0.46, 1.40, 0.27, 1.12);
  casing(trim, 0, 1.78, 0.97, 2.36, 0.36, 0.31);
  box(recess, 0, 1.76, 1.134, 1.12, 0.21, 0.032);
  for (const x of [-0.31, 0, 0.31]) box(signal, x, 1.76, 1.154, 0.21, 0.064, 0.02, true);
  box(rib, 0, 1.39, 0.29, 1.35, 0.16, 0.26);
  casing(armor, 0, 1.22, 0.29, 0.56, 0.29, 0.40);
  box(hazard, 0, 1.089, 0.40, 0.18, 0.032, 0.17, true);

  for (const side of [-1, 1]) {
    const x = side * 0.89;
    const height = side > 0 ? 2.99 : 2.72;
    drum(rib, x, 2.04, -0.72, 0.75, 0.35, 0.75);
    drum(armor, x, (height + 2.10) / 2, -0.72, 0.53, height - 2.10, 0.53);
    for (const y of [2.26, 2.41, height - 0.26]) drum(plinth, x, y, -0.72, 0.64, 0.064, 0.64);
    drum(trim, x, height - 0.071, -0.72, 0.66, 0.162, 0.66);
    drum(recess, x, height + 0.016, -0.72, 0.42, 0.022, 0.42);
    box(hazard, x, 2.18, -0.44, 0.28, 0.065, 0.044, true);
  }
}

function makeBuildingModel(type) {
  const group = new THREE.Group();
  const { steel, dark, shell, cyan, amber, panel } = palette;
  const box = (...args) => primitive(group, 'box', ...args);
  const drum = (...args) => primitive(group, 'drum', ...args);
  const casing = (...args) => primitive(group, 'casing', ...args);
  if (type === 'farm') return farmModel(group);
  if (type === 'wall') {
    casing('#293740', 0, 0.13, 0, 0.91, 0.27, WALL_LENGTH);
    casing('#526571', 0, 0.78, 0, 0.72, 1.21, WALL_LENGTH);
    box('#354b57', 0, 1.32, 0, 0.94, 0.19, WALL_LENGTH);
    for (const side of [-1, 1]) {
      const z = side * WALL_LENGTH / 2;
      drum('#465965', 0, 0.74, z, 0.84, 1.44, 0.84);
      drum('#8ca0a5', 0, 1.46, z, 0.9, 0.15, 0.9);
      box('#b8a378', side * 0.375, 0.94, 0, 0.037, 0.14, WALL_LENGTH * 0.74);
      for (const brace of [-0.55, 0.55]) box('#6b7c83', side * 0.379, 0.56, brace, 0.045, 0.61, 0.13);
    }
    return group;
  }
  if (type === 'command') {
    drum(dark, 0, 0.05, 0, 4.6, 0.22, 4.5);
    drum(steel, 0, 0.19, 0, 4.37, 0.13, 4.25);
    drum('#435861', 0, 0.27, 0, 3.93, 0.11, 3.85);
    drum(dark, 0, 0.7, -0.1, 3.12, 0.74, 3.16);
    drum(shell, 0, 1.12, -0.1, 2.89, 0.57, 2.93);
    drum('#9baab0', 0, 1.46, -0.1, 2.5, 0.18, 2.63);
    drum('#607781', 0, 1.56, -0.12, 2.24, 0.10, 2.28);
    box(dark, 0, 1.47, -0.06, 1.65, 0.25, 1.55);
    box(panel, 0, 1.64, -0.38, 1.23, 0.08, 0.88);
    box(cyan, 0, 1.698, -0.31, 0.82, 0.025, 0.11, true);
    box(steel, 0, 0.43, 1.86, 0.97, 0.16, 1.37).rotation.x = 0.24;
    box(cyan, 0, 0.92, 1.39, 0.76, 0.18, 0.04, true);
    for (const side of [-1, 1]) {
      drum(dark, side * 1.55, 0.43, -0.45, 0.82, 0.55, 1.08);
      drum(shell, side * 1.55, 0.76, -0.45, 0.81, 0.21, 1.08);
      box(cyan, side * 1.67, 0.98, 0.12, 0.06, 0.18, 0.59, true);
      box(amber, side * 0.62, 0.32, 1.78, 0.16, 0.05, 0.65, true);
      box(dark, side * 1.93, 0.41, 0.65, 0.28, 0.34, 0.54);
      casing('#7f9299', side * 1.57, 0.95, -0.66, 0.48, 0.24, 0.53);
      box('#9bbec5', side * 0.66, 0.89, 1.25, 0.06, 0.12, 0.36).rotation.y = side * 0.56;
      for (const step of [0, 1, 2]) box('#a4a6a0', side * 0.37, 0.31 + step * 0.044, 2.20 - step * 0.12, 0.20, 0.025, 0.055);
    }
    drum(steel, 0.79, 1.85, -0.72, 0.12, 0.58, 0.12);
    primitive(group, 'fitting', cyan, 0.79, 2.15, -0.72, 0.20, 0.1, 0.20, true);
    return group;
  }

  drum(dark, 0, 0.03, 0, 2.4, 0.16, 2.3);
  if (type === 'mine') {
    const safety = '#e6a84c';
    box('#34414a', 0, 0.18, 0, 2.12, 0.25, 1.78);
    box(steel, 0, 0.34, 0.33, 1.76, 0.17, 0.79);
    for (const side of [-1, 1]) {
      box(dark, side * 0.77, 0.27, -0.13, 0.38, 0.28, 1.31);
      box(safety, side * 0.73, 1.32, -0.16, 0.23, 2.12, 0.40);
      box(safety, side * 0.72, 0.88, -0.38, 0.12, 1.42, 0.15).rotation.x = -0.54;
      box('#ffe387', side * 0.73, 1.98, 0.055, 0.18, 0.11, 0.04, true);
    }
    box(dark, 0, 2.34, -0.12, 1.89, 0.22, 0.66);
    box(safety, 0, 2.49, -0.12, 1.94, 0.13, 0.69);
    drum(steel, 0, 1.60, -0.12, 0.32, 1.16, 0.32);
    drum('#566771', 0, 0.91, -0.12, 0.54, 0.19, 0.54);
    primitive(group, 'cone', '#a1b5bd', 0, 0.60, -0.12, 0.46, 0.56, 0.46).rotation.z = Math.PI;
    box(dark, 0.5, 0.40, 0.59, 0.52, 0.38, 0.34);
    box(cyan, 0.5, 0.48, 0.77, 0.36, 0.09, 0.03, true);
    casing('#526773', -0.51, 0.48, 0.48, 0.48, 0.39, 0.62);
    drum('#cf9957', -0.51, 0.69, 0.42, 0.25, 0.12, 0.28);
    for (const side of [-1, 1]) {
      box('#c3934d', side * 0.67, 2.12, -0.57, 0.12, 0.65, 0.14).rotation.x = 0.56;
      box(steel, side * 0.9, 0.52, 0.29, 0.25, 0.26, 0.52);
    }
    for (const x of [-0.88, -0.52, -0.16, 0.20, 0.56, 0.92]) box(safety, x, 0.33, 0.82, 0.19, 0.034, 0.12);
  } else if (type === 'solar') {
    for (const side of [-0.57, 0.57]) {
      box(steel, side, 0.36, 0, 0.12, 0.63, 0.15);
      const rack = new THREE.Group();
      rack.position.set(side, 0.8, 0);
      rack.rotation.x = -0.38;
      group.add(rack);
      primitive(rack, 'casing', shell, 0, 0, 0, 1.05, 0.115, 1.38);
      primitive(rack, 'box', dark, 0, 0.065, 0, 0.98, 0.055, 1.28);
      for (let row = 0; row < 5; row++) {
        for (let column = 0; column < 3; column++) {
          primitive(rack, 'plate', (row + column) % 3 ? '#376a92' : '#4c82a7', (column - 1) * 0.30, 0.096, (row - 2) * 0.235,
            0.275, 0.019, 0.21);
        }
      }
      drum('#708995', side, 0.13, 0, 0.36, 0.22, 0.34);
    }
    casing(steel, 0, 0.18, 0.77, 0.33, 0.27, 0.29);
    box(cyan, 0, 0.26, 0.923, 0.14, 0.043, 0.018, true);
  } else if (type === 'habitat') {
    for (const side of [-0.48, 0.48]) {
      drum(shell, side, 0.52, 0, 0.84, 0.83, 1.54);
      drum('#8faab7', side, 0.96, 0, 0.75, 0.16, 1.42);
      box(cyan, side, 0.53, 0.73, 0.42, 0.14, 0.04, true);
      casing('#6b8795', side, 0.46, -0.63, 0.55, 0.59, 0.32);
      box(dark, side - 0.15, 0.60, 0.764, 0.14, 0.17, 0.026);
      box(dark, side + 0.15, 0.60, 0.764, 0.14, 0.17, 0.026);
      box('#526d79', side, 1.05, -0.24, 0.40, 0.06, 0.45);
    }
    box(dark, 0, 0.32, 0.46, 0.32, 0.43, 0.6);
    casing('#8ea2aa', 0, 0.37, 0.80, 0.24, 0.38, 0.21);
    box(amber, 0, 0.56, 0.913, 0.14, 0.04, 0.025, true);
  } else if (type === 'bio') {
    casing(steel, 0, 0.24, 0, 1.65, 0.34, 1.43);
    for (const side of [-0.52, 0.52]) {
      drum('#5e886c', side, 0.59, 0, 0.56, 0.75, 0.58);
      primitive(group, 'band', '#9bb2a3', side, 0.81, 0, 0.61, 0.065, 0.62);
      drum(shell, side, 0.99, 0, 0.46, 0.10, 0.45);
      primitive(group, 'fitting', dark, side, 1.08, 0, 0.19, 0.09, 0.19);
      box('#a5c287', side, 0.58, 0.298, 0.16, 0.29, 0.014);
    }
    casing('#3d574b', 0, 0.43, 0.56, 0.35, 0.36, 0.43);
    box('#8aaf77', 0, 0.65, -0.16, 0.105, 0.12, 1.03);
    box(amber, 0, 0.41, 0.71, 0.54, 0.09, 0.06, true);
  } else if (type === 'foundry') {
    foundryModel(group);
  } else if (type === 'factory') {
    casing(steel, 0, 0.57, -0.18, 1.92, 1.05, 1.58);
    casing('#80939c', 0, 1.08, -0.18, 1.41, 0.21, 1.46);
    box(dark, 0, 0.52, 0.62, 1.26, 0.88, 0.08);
    box(cyan, 0, 0.96, 0.67, 0.91, 0.09, 0.08, true);
    for (const side of [-1, 1]) {
      box(shell, side * 0.86, 0.63, 0.23, 0.25, 1.16, 1.58);
      drum(dark, side * 0.58, 1.21, -0.58, 0.28, 0.42, 0.30);
      primitive(group, 'fitting', '#b5aaa4', side * 0.58, 1.43, -0.58, 0.31, 0.11, 0.33);
      box(amber, side * 0.72, 0.49, 1.027, 0.090, 0.74, 0.035);
      for (const z of [-0.2, 0.06, 0.32]) box(dark, side * 0.997, 0.63, z, 0.032, 0.23, 0.115);
    }
    for (const y of [0.43, 0.55, 0.67]) box('#596d76', 0, y, 0.674, 1.07, 0.026, 0.025);
    box('#78959b', 0, 0.13, 0.92, 1.17, 0.14, 0.56).rotation.x = 0.15;
  } else if (type === 'relay') {
    drum(steel, 0, 0.44, 0, 0.73, 0.80, 0.73);
    drum(dark, 0, 1.16, 0, 0.19, 1.23, 0.19);
    for (const side of [-1, 1]) {
      box(steel, side * 0.18, 1.14, 0, 0.085, 1.43, 0.12).rotation.z = side * -0.26;
      casing('#597782', side * 0.47, 0.38, 0, 0.29, 0.48, 0.64);
      box(cyan, side * 0.49, 0.47, 0.335, 0.13, 0.07, 0.022, true);
    }
    const reflector = new THREE.Group();
    reflector.position.set(0, 1.77, 0.02);
    reflector.rotation.set(0.62, 0, -0.22);
    group.add(reflector);
    primitive(reflector, 'dish', shell, 0, 0, 0, 1.26, 0.81, 1.26);
    primitive(reflector, 'fitting', dark, 0, 0.16, 0, 0.07, 0.36, 0.07);
    primitive(reflector, 'sphere', cyan, 0, 0.34, 0, 0.14, 0.15, 0.14, true);
  } else if (type === 'hydro') {
    for (const side of [-1, 1]) {
      casing(dark, side * 0.53, 0.25, 0, 0.94, 0.38, 1.71);
      drum('#639d99', side * 0.53, 0.55, 0, 0.88, 1.60, 0.68).rotation.x = Math.PI / 2;
      for (const z of [-0.63, 0, 0.63]) {
        primitive(group, 'band', '#a8c7ba', side * 0.53, 0.54, z, 0.91, 0.055, 0.699).rotation.x = Math.PI / 2;
      }
      box('#84c9ad', side * 0.53, 0.887, -0.05, 0.12, 0.038, 1.32);
      box('#41635f', side * 0.53, 0.54, 0.811, 0.29, 0.37, 0.03);
      box('#a0ecc3', side * 0.53, 0.632, 0.834, 0.18, 0.09, 0.021, true);
    }
  } else if (type === 'tower' || type === 'bastion') {
    const bastion = type === 'bastion';
    drum(steel, 0, 0.55, 0, bastion ? 1.5 : 0.82, 1.0, bastion ? 1.5 : 0.82);
    drum(shell, 0, 1.13, 0, bastion ? 1.45 : 0.96, 0.34, bastion ? 1.45 : 0.96);
    casing(dark, 0, 1.36, 0, bastion ? 1.04 : 0.71, 0.38, 0.75);
    for (const x of bastion ? [-0.22, 0.22] : [0]) {
      box(steel, x, 1.43, 0.51, 0.15, 0.16, 1.14);
      primitive(group, 'fitting', dark, x, 1.43, 0.72, 0.15, 0.50, 0.15).rotation.x = Math.PI / 2;
      primitive(group, 'fitting', '#9fa9aa', x, 1.43, 0.95, 0.21, 0.14, 0.21).rotation.x = Math.PI / 2;
    }
    box(amber, 0, 1.55, 0.06, 0.42, 0.06, 0.30, true);
  } else if (type === 'crystalTap') {
    drum('#706395', 0, 0.38, 0, 1.47, 0.51, 1.39);
    primitive(group, 'shard', '#ac8fdf', 0, 0.91, 0, 0.57, 1.07, 0.51).rotation.z = 0.12;
    primitive(group, 'shard', '#d4bdf8', 0.23, 0.61, 0.25, 0.28, 0.68, 0.26).rotation.x = 0.31;
    drum('#a99cbd', 0, 0.68, 0, 1.16, 0.10, 1.08);
    for (const side of [-1, 1]) {
      casing(shell, side * 0.73, 0.61, 0, 0.24, 1.1, 0.91);
      box('#e2c3fe', side * 0.735, 0.81, 0.463, 0.13, 0.11, 0.018, true);
    }
  } else if (type === 'uplink') {
    box(steel, -0.39, 0.39, -0.15, 1.05, 0.67, 1.52);
    box(dark, -0.39, 0.75, -0.15, 1.05, 0.14, 1.52);
    box('#b8b0f7', -0.39, 0.48, 0.62, 0.60, 0.13, 0.055, true);
    drum(dark, -0.44, 1, -0.18, 0.37, 0.45, 0.37);
    const dish = new THREE.Group();
    dish.name = 'dish';
    dish.position.set(-0.44, 1.35, -0.18);
    const reflector = new THREE.Group();
    reflector.rotation.x = 0.67;
    primitive(reflector, 'dish', '#a7b6ca', 0, 0, 0, 1.56, 1, 1.56);
    primitive(reflector, 'drum', '#273e51', 0, 0.27, 0, 0.095, 0.54, 0.095);
    primitive(reflector, 'sphere', cyan, 0, 0.53, 0, 0.13, 0.13, 0.13, true);
    for (const x of [-0.25, 0.25]) primitive(reflector, 'box', cyan, x, 0.17, 0.31, 0.14, 0.06, 0.06, true);
    dish.add(reflector);
    group.add(dish);
    drum('#465864', 0.64, 0.21, 0.47, 0.77, 0.24, 0.77);
    const rocket = new THREE.Group();
    rocket.name = 'rocket';
    rocket.position.set(0.64, 0.32, 0.47);
    primitive(rocket, 'drum', shell, 0, 0.48, 0, 0.29, 0.96, 0.29);
    primitive(rocket, 'cone', '#d3c8ff', 0, 1.13, 0, 0.29, 0.38, 0.29);
    primitive(rocket, 'drum', '#565f9b', 0, 0.26, 0, 0.30, 0.16, 0.30);
    for (const x of [-0.19, 0.19]) primitive(rocket, 'box', steel, x, 0.17, 0, 0.12, 0.29, 0.27);
    const exhaust = primitive(rocket, 'cone', '#8fefff', 0, -0.39, 0, 0.36, 0.76, 0.36, true);
    exhaust.name = 'exhaust';
    exhaust.rotation.z = Math.PI;
    exhaust.visible = false;
    group.add(rocket);
    for (const z of [-0.08, 0.26, 0.6]) box('#718b96', -0.945, 0.48, z, 0.042, 0.18, 0.23);
    casing('#60777d', 0.54, 0.17, -0.44, 0.44, 0.26, 0.37);
  } else if (type === 'reclaimer') {
    casing('#426065', 0, 0.50, 0.04, 1.04, 0.85, 1.31);
    box('#9dc0b3', 0, 0.94, 0.03, 0.78, 0.15, 1.14);
    box('#223634', 0, 0.56, 0.72, 0.58, 0.41, 0.045);
    box('#c7ae71', 0, 0.77, 0.75, 0.59, 0.067, 0.049, true);
    for (const side of [-1, 1]) {
      drum(steel, side * 0.67, 0.32, -0.18, 0.43, 0.50, 0.49);
      drum('#8d9e80', side * 0.67, 0.61, -0.18, 0.51, 0.16, 0.55);
      box(dark, side * 0.57, 0.34, 0.42, 0.26, 0.44, 0.35);
    }
  } else if (type === 'synthesizer') {
    casing('#465467', 0, 0.31, 0, 1.81, 0.43, 1.51);
    drum('#2898a0', 0, 0.78, 0, 0.84, 0.72, 0.89);
    drum('#85dfcf', 0, 1.03, 0, 0.69, 0.17, 0.73, true);
    drum('#67758b', 0, 1.23, 0, 0.91, 0.24, 0.95);
    primitive(group, 'shard', '#b0ddd8', 0, 1.46, 0, 0.34, 0.41, 0.34, true);
    for (const side of [-1, 1]) {
      casing('#726e95', side * 0.66, 0.58, 0, 0.33, 0.67, 1.22);
      box('#a9cfc4', side * 0.67, 0.65, 0.614, 0.16, 0.16, 0.024, true);
    }
  } else if (type === 'geoTap' || type === 'fusion') {
    const fusion = type === 'fusion';
    const signal = fusion ? cyan : '#ffc29c';
    drum(dark, 0, 0.51, 0, 1.61, 0.84, 1.66);
    drum(steel, 0, 0.98, 0, 1.53, 0.28, 1.54);
    drum(signal, 0, 1.18, 0, fusion ? 0.91 : 0.57, 0.34, fusion ? 0.91 : 0.57, true);
    drum('#98a7ac', 0, 1.35, 0, fusion ? 0.88 : 0.52, 0.13, fusion ? 0.88 : 0.52);
    for (const side of [-1, 1]) {
      drum(shell, side * 0.78, 0.78, -0.61, 0.29, 1.31, 0.32);
      primitive(group, 'fitting', dark, side * 0.78, 1.45, -0.61, 0.31, 0.10, 0.34);
      box(fusion ? '#527c86' : '#a1785e', side * 0.73, 0.48, 0.26, 0.28, 0.32, 0.70);
    }
  } else {
    drum('#755452', 0, 0.43, 0, 1.86, 0.66, 1.67);
    drum('#ad8a77', 0, 0.83, 0, 1.68, 0.21, 1.51);
    box('#f39f70', 0, 0.58, 0.79, 0.63, 0.11, 0.04, true);
    drum(dark, 0.36, 1.15, 0, 0.13, 0.48, 0.13);
    casing('#ad8a77', -0.48, 0.86, 0.18, 0.51, 0.47, 0.76);
    box('#e5b781', -0.46, 0.85, 0.572, 0.31, 0.13, 0.027, true);
  }
  return group;
}

function modelReptile(ancient) {
  const group = new THREE.Group();
  const hide = ancient ? '#8c6551' : '#435643';
  const scales = ancient ? '#bc9161' : '#78815c';
  const belly = ancient ? '#67544b' : '#56604c';
  const sphere = (...args) => primitive(group, 'sphere', ...args);
  sphere(belly, 0, 0.57, 0.05, 1.08, 0.85, 1.71);
  primitive(group, 'round', hide, 0, 0.82, -0.14, 1.15, 0.79, 1.86);
  sphere(hide, 0, 0.74, 0.83, 0.67, 0.61, 0.71);
  primitive(group, 'round', scales, 0, 0.86, 1.18, 0.76, 0.58, 0.79);
  sphere(belly, 0, 0.63, 1.39, 0.54, 0.18, 0.61);
  sphere(hide, 0, 0.77, 1.58, 0.50, 0.25, 0.35);
  for (const side of [-1, 1]) {
    sphere('#ffd48a', side * 0.32, 0.96, 1.29, 0.09, 0.10, 0.085, true);
    sphere('#292323', side * 0.365, 0.96, 1.3, 0.028, 0.067, 0.043);
    sphere(hide, side * 0.27, 1.04, 1.17, 0.28, 0.13, 0.39);
    for (const z of [-0.55, 0.46]) {
      const leg = sphere(hide, side * 0.57, 0.36, z, 0.42, 0.72, 0.32);
      leg.rotation.z = side * 0.47;
      sphere(belly, side * 0.71, 0.12, z + 0.10, 0.31, 0.20, 0.46);
      for (const spread of [-0.075, 0.075]) {
        const claw = primitive(group, 'leaf', '#a49a80', side * 0.72 + spread, 0.11, z + 0.31, 0.10, 0.15, 0.14);
        claw.rotation.x = 0.17;
      }
    }
  }
  const tail = new THREE.Group();
  tail.name = 'tail';
  tail.position.set(0, 0.58, -0.85);
  group.add(tail);
  for (let index = 0; index < 5; index++) {
    const taper = 1 - index * 0.15;
    primitive(tail, 'sphere', index < 2 ? hide : scales, 0, -index * 0.05, -index * 0.31,
      0.67 * taper, 0.57 * taper, 0.63 * taper);
  }
  for (let index = 0; index < 6; index++) {
    const ridge = primitive(group, 'cone', scales, 0, 1.15, -0.28 - index * 0.22, 0.27 - index * 0.019, 0.39 - index * 0.031, 0.3);
    ridge.rotation.x = -0.37;
  }
  group.scale.setScalar(ancient ? 1.64 : 1.3);
  return group;
}

function makeUnitModel(type) {
  const asset = unitAssets.get(type);
  if (asset) {
    const group = new THREE.Group();
    const mount = asset.find(({ name }) => name === 'turret');
    const turret = mount ? new THREE.Group() : null;
    if (turret) {
      turret.name = 'turret';
      turret.position.fromArray(mount.origin);
      group.add(turret);
    }
    for (const part of asset) {
      const mesh = new THREE.Mesh(part.geometry, ['lights', 'turretLights'].includes(part.name) ? unitLights : unitBody);
      if (turret && part.name.startsWith('turret')) {
        turret.add(mesh);
      } else {
        mesh.name = part.name;
        mesh.position.fromArray(part.origin);
        group.add(mesh);
      }
    }
    group.scale.setScalar(UNITS[type]?.scale ?? (type === 'ancient' ? 1.64 : type === 'reptile' ? 1.3 : 1));
    return group;
  }
  if (type === 'reptile' || type === 'ancient') return modelReptile(type === 'ancient');
  const group = new THREE.Group();
  const { dark, shell, steel, cyan, amber, tread } = palette;
  const box = (...args) => primitive(group, 'box', ...args);
  const casing = (...args) => primitive(group, 'casing', ...args);
  const definition = UNITS[type];
  const chassis = definition?.model ?? type;
  if (chassis === 'rover') {
    const armored = definition.combat;
    const paint = type === 'rover' ? '#c19457' : type === 'siege' ? '#776986' : type === 'vanguard' ? '#708691' : '#527f7e';
    for (const side of [-1, 1]) {
      box(tread, side * 0.38, 0.19, 0, 0.26, 0.36, 1.05);
      for (const z of [-0.32, 0.32]) {
        const wheel = primitive(group, 'drum', '#57666a', side * 0.51, 0.2, z, 0.29, 0.045, 0.29);
        wheel.rotation.z = Math.PI / 2;
      }
      box(steel, side * 0.46, 0.37, 0, 0.19, 0.08, 1.02);
      box('#a9b7b1', side * 0.50, 0.40, 0.48, 0.083, 0.12, 0.085);
      box('#f6d59d', side * 0.48, 0.433, 0.527, 0.092, 0.041, 0.024, true);
    }
    casing(dark, 0, 0.27, 0, 0.75, 0.33, 1.18);
    casing(paint, 0, 0.46, -0.05, 0.69, 0.30, 0.91);
    box(shell, 0, 0.65, -0.04, 0.45, 0.13, 0.52);
    box(cyan, 0, 0.49, 0.425, 0.38, 0.105, 0.028, true);
    if (armored) {
      const length = type === 'siege' ? 0.96 : 0.64;
      box(paint, 0, 0.76, -0.06, 0.42, 0.18, 0.48);
      const barrel = primitive(group, 'drum', dark, 0, 0.793, 0.25, type === 'siege' ? 0.17 : 0.12, length, type === 'siege' ? 0.17 : 0.12);
      barrel.rotation.x = Math.PI / 2;
      box(steel, 0, 0.79, 0.25 + length * 0.45, 0.19, 0.16, 0.12);
    } else {
      box(steel, 0, 0.56, -0.39, 0.55, 0.15, 0.28);
      box(amber, 0.16, 0.72, -0.31, 0.11, 0.30, 0.12).rotation.x = -0.40;
      box(amber, 0.16, 0.79, -0.12, 0.10, 0.11, 0.34).rotation.x = 0.26;
      box(steel, 0.16, 0.73, 0.063, 0.15, 0.10, 0.13);
    }
  } else if (chassis === 'scout') {
    const advanced = type === 'drone';
    casing(dark, 0, 0.32, 0, 0.68, 0.23, 1.10);
    casing(advanced ? '#a59bc0' : shell, 0, 0.5, -0.01, 0.48, 0.24, 0.90);
    casing('#54869b', 0, 0.59, 0.22, 0.35, 0.11, 0.35);
    box(cyan, 0, 0.56, 0.492, 0.28, 0.048, 0.07, true);
    for (const side of [-1, 1]) {
      box(dark, side * 0.45, 0.25, -0.13, 0.28, 0.24, 0.74);
      box(steel, side * 0.45, 0.391, -0.14, 0.27, 0.10, 0.64);
      box(cyan, side * 0.45, 0.23, 0.26, 0.16, 0.075, 0.04, true);
      box(advanced ? '#c8aafd' : '#82bcce', side * 0.43, 0.263, -0.507, 0.18, 0.10, 0.05, true);
    }
    if (advanced) box(steel, 0, 0.67, -0.15, 0.36, 0.08, 0.47);
  } else {
    const armored = type === 'sentinel';
    const armor = armored ? '#649bb9' : '#abd1ca';
    box(tread, -0.11, 0.16, 0, 0.15, 0.30, 0.22);
    box(tread, 0.11, 0.16, 0, 0.15, 0.30, 0.22);
    casing(armor, 0, 0.43, 0, 0.39, 0.33, 0.24);
    primitive(group, 'sphere', armor, 0, 0.71, 0, 0.32, 0.28, 0.30);
    box(dark, 0, 0.465, -0.15, 0.23, 0.26, 0.19);
    box(steel, 0, 0.44, 0.125, 0.19, 0.16, 0.052);
    for (const side of [-1, 1]) {
      box(armor, side * 0.206, 0.46, 0.017, armored ? 0.17 : 0.13, 0.18, 0.17);
      box(steel, side * 0.115, 0.17, 0.095, 0.107, 0.13, 0.061);
    }
    box(dark, 0.22, 0.45, 0.19, 0.11, 0.12, 0.37);
    box(steel, 0.22, 0.458, 0.397, 0.071, 0.074, 0.21);
    box(cyan, 0, 0.72, 0.11, 0.17, 0.07, 0.035, true);
  }
  group.scale.setScalar(definition?.scale ?? 1);
  return group;
}

