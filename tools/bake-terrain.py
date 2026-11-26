"""Render seamless terrain materials with Blender's CPU renderer.

Run with blender --background --factory-startup --python tools/bake-terrain.py
"""

from itertools import product
from math import cos, sin, tau
from pathlib import Path
from random import Random
import sys

import bpy
from mathutils import Vector


ASSETS = Path(__file__).resolve().parents[1] / "assets" / "terrain"


class Material:
    def __init__(self, name, radius_x, radius_y):
        self.material = bpy.data.materials.new(name)
        self.material.use_nodes = True
        self.tree = self.material.node_tree
        self.tree.nodes.clear()
        uv = self.node("ShaderNodeTexCoord").outputs["UV"]
        axes = self.node("ShaderNodeSeparateXYZ", Vector=uv).outputs
        u, v = (self.math("MULTIPLY", axes[axis], tau) for axis in ("X", "Y"))
        self.u, self.v = u, v

        # Both axes wrap around a circle in 4D, so every noise layer tiles.
        self.vector = self.node(
            "ShaderNodeCombineXYZ",
            X=self.math("MULTIPLY", self.math("COSINE", u), radius_x),
            Y=self.math("MULTIPLY", self.math("SINE", u), radius_x),
            Z=self.math("MULTIPLY", self.math("COSINE", v), radius_y),
        ).outputs["Vector"]
        self.w = self.math("MULTIPLY", self.math("SINE", v), radius_y)

    def connect(self, source, target):
        if isinstance(source, bpy.types.NodeSocket):
            self.tree.links.new(source, target)
        else:
            target.default_value = source

    def node(self, kind, **inputs):
        node = self.tree.nodes.new(kind)
        for key, value in inputs.items():
            self.connect(value, node.inputs[key])
        return node

    def math(self, operation, first, second=0):
        node = self.node("ShaderNodeMath")
        node.operation = operation
        self.connect(first, node.inputs[0])
        self.connect(second, node.inputs[1])
        return node.outputs[0]

    def noise(self, scale, detail, roughness=0.65, distortion=0.0):
        node = self.node("ShaderNodeTexNoise")
        node.noise_dimensions = "4D"
        for key, val in (
            ("Vector", self.vector), ("W", self.w), ("Scale", scale),
            ("Detail", detail), ("Roughness", roughness), ("Distortion", distortion),
        ):
            self.connect(val, node.inputs[key])
        return node.outputs["Fac"]

    def joints(self, scale, warp):
        displacement = self.node("ShaderNodeCombineXYZ", X=warp, Y=self.math("MULTIPLY", warp, -0.72))
        shifted = self.node("ShaderNodeVectorMath")
        shifted.operation = "ADD"
        self.connect(self.vector, shifted.inputs[0])
        self.connect(displacement.outputs["Vector"], shifted.inputs[1])
        node = self.node("ShaderNodeTexVoronoi")
        node.voronoi_dimensions = "4D"
        node.feature = "DISTANCE_TO_EDGE"
        self.connect(shifted.outputs["Vector"], node.inputs["Vector"])
        self.connect(self.w, node.inputs["W"])
        self.connect(scale, node.inputs["Scale"])
        return node.outputs["Distance"]

    def ramp(self, factor, *stops):
        node = self.node("ShaderNodeValToRGB", Fac=factor)
        ramp = node.color_ramp
        ramp.interpolation = "LINEAR"
        for index, (position, color) in enumerate(stops):
            element = ramp.elements[index] if index < 2 else ramp.elements.new(position)
            element.position = position
            rgb = (color,) * 3 if isinstance(color, (int, float)) else color
            element.color = (*rgb, 1.0)
        return node.outputs["Color"]

    def mix(self, factor, first, second):
        return self.node("ShaderNodeMixRGB", Fac=factor, Color1=first, Color2=second).outputs["Color"]

    def surface(self, color, height, roughness, depth):
        bump = self.node("ShaderNodeBump", Height=height, Strength=0.82, Distance=depth)
        shader = self.node("ShaderNodeBsdfPrincipled", **{
            "Base Color": color, "Roughness": roughness, "Normal": bump.outputs["Normal"],
        })
        self.node("ShaderNodeOutputMaterial", Surface=shader.outputs["BSDF"])
        return self.material


def mountain():
    mat = Material("Weathered mountain rock", 0.22, 0.11)
    shelves = mat.noise(14, 4, distortion=0.39)
    grains = mat.noise(97, 2)
    weathering = mat.noise(8, 3)
    bedding = mat.math("ADD", mat.math("MULTIPLY", mat.u, 3), mat.math("MULTIPLY", mat.v, 8))
    bedding = mat.math("SINE", mat.math("ADD", bedding, mat.math("MULTIPLY", shelves, 7)))
    layers = mat.ramp(bedding, (0.02, 0.40), (0.31, 0.76), (0.68, 1.0))
    seams = mat.joints(15, mat.math("MULTIPLY", mat.noise(17, 3), 0.15))
    flakes = mat.ramp(seams, (0.006, 0.24), (0.032, 0.84), (0.10, 1.0))
    flakes = mat.mix(mat.ramp(weathering, (0.36, 0.25), (0.61, 0.90)), (1, 1, 1, 1), flakes)
    stone = mat.ramp(
        shelves,
        (0.29, (0.063, 0.071, 0.069)),
        (0.49, (0.20, 0.167, 0.123)),
        (0.69, (0.40, 0.319, 0.218)),
    )
    grit = mat.ramp(grains, (0.28, (0.058, 0.059, 0.051)), (0.73, (0.24, 0.196, 0.141)))
    stone = mat.mix(mat.math("MULTIPLY", flakes, layers), grit, stone)
    height = mat.math("ADD", mat.math("ADD", shelves, mat.math("MULTIPLY", layers, 0.20)),
                      mat.math("ADD", mat.math("MULTIPLY", flakes, 0.22), mat.math("MULTIPLY", grains, 0.28)))
    return mat.surface(stone, height, 0.87, 0.039)


def crystal():
    mat = Material("Amethyst veins in slate", 0.145, 0.17)
    slate = mat.noise(12, 4, distortion=0.31)
    grains = mat.noise(118, 2)
    fracture = mat.joints(15, mat.math("MULTIPLY", mat.noise(24, 3), 0.15))
    veins = mat.ramp(fracture, (0.014, 1.0), (0.038, 0.74), (0.071, 0.20), (0.109, 0.0))
    concentrations = mat.ramp(mat.noise(11, 3), (0.30, 0.12), (0.65, 1.0))
    mineral = mat.math("MULTIPLY", veins, concentrations)
    host = mat.ramp(
        slate,
        (0.25, (0.062, 0.069, 0.088)),
        (0.48, (0.127, 0.132, 0.167)),
        (0.74, (0.243, 0.246, 0.295)),
    )
    purple = mat.ramp(
        grains,
        (0.28, (0.169, 0.098, 0.30)),
        (0.52, (0.317, 0.197, 0.48)),
        (0.71, (0.59, 0.47, 0.73)),
    )
    height = mat.math("ADD", slate, mat.math("ADD", mat.math("MULTIPLY", mineral, 0.27),
                                          mat.math("MULTIPLY", grains, 0.31)))
    return mat.surface(mat.mix(mineral, host, purple), height, 0.71, 0.018)


def grass():
    mat = Material("Meadow floor", 0.16, 0.16)
    growth = mat.noise(5.8, 4, distortion=0.35)
    thatch = mat.noise(74, 3)
    grit = mat.noise(185, 2)
    earth = mat.ramp(
        growth,
        (0.28, (0.032, 0.066, 0.016)),
        (0.49, (0.040, 0.130, 0.018)),
        (0.71, (0.088, 0.215, 0.032)),
    )
    ground_blades = mat.ramp(thatch, (0.27, (0.027, 0.055, 0.014)), (0.71, (0.18, 0.27, 0.055)))
    return mat.surface(mat.mix(0.32, earth, ground_blades), grit, 0.95, 0.005)


def forest():
    mat = Material("Moss and forest duff", 0.19, 0.17)
    moss = mat.noise(8.8, 4, distortion=0.47)
    mulch = mat.noise(29, 4, distortion=0.21)
    grains = mat.noise(132, 2)
    earth = mat.ramp(mulch, (0.27, (0.028, 0.020, 0.010)), (0.69, (0.127, 0.084, 0.039)))
    velvet = mat.ramp(grains, (0.30, (0.026, 0.073, 0.018)), (0.70, (0.104, 0.178, 0.043)))
    cover = mat.ramp(moss, (0.36, 0.0), (0.49, 0.31), (0.58, 0.95))
    surface = mat.mix(cover, earth, velvet)
    height = mat.math("ADD", mat.math("MULTIPLY", moss, 0.55), mat.math("MULTIPLY", grains, 0.31))
    return mat.surface(surface, height, 0.94, 0.013)


def desert():
    mat = Material("Windblown sandstone and sand", 0.17, 0.15)
    drift = mat.noise(4.4, 4, distortion=0.32)
    grains = mat.noise(194, 2)
    gust = mat.noise(17, 3)
    wind = mat.math("ADD", mat.math("MULTIPLY", mat.u, 4), mat.math("MULTIPLY", mat.v, 23))
    wind = mat.math("ADD", wind, mat.math("MULTIPLY", drift, 18))
    wind = mat.math("ADD", wind, mat.math("MULTIPLY", gust, 3.9))
    profile = mat.math("ADD", mat.math("MULTIPLY", mat.math("SINE", wind), 0.5), 0.5)
    crests = mat.math("POWER", profile, 3.2)
    exposed = mat.ramp(gust, (0.35, 0.12), (0.64, 0.98))
    ripples = mat.math("MULTIPLY", crests, exposed)
    sand = mat.ramp(
        drift,
        (0.25, (0.240, 0.142, 0.067)),
        (0.49, (0.435, 0.303, 0.150)),
        (0.71, (0.570, 0.421, 0.224)),
    )
    dust = mat.ramp(grains, (0.30, (0.225, 0.130, 0.064)), (0.72, (0.640, 0.466, 0.225)))
    sand = mat.mix(0.23, sand, dust)
    troughs = mat.math("MULTIPLY", mat.math("SUBTRACT", 1, profile), exposed)
    sand = mat.mix(mat.math("MULTIPLY", troughs, 0.31), sand, (0.27, 0.16, 0.084, 1))
    sand = mat.mix(mat.math("MULTIPLY", ripples, 0.48), sand, (0.68, 0.50, 0.27, 1))
    height = mat.math("ADD", mat.math("MULTIPLY", ripples, 0.61), mat.math("MULTIPLY", grains, 0.25))
    return mat.surface(sand, height, 0.93, 0.015)


class Scatter:
    def __init__(self, name, shades):
        self.name = name
        self.shades = shades
        self.vertices = []
        self.faces = []
        self.indices = []

    def mesh(self, x, y, points, faces, shade):
        wrap_x = [0, 2] if x < -0.89 else [0, -2] if x > 0.89 else [0]
        wrap_y = [0, 2] if y < -0.89 else [0, -2] if y > 0.89 else [0]
        for dx, dy in product(wrap_x, wrap_y):
            first = len(self.vertices)
            self.vertices.extend((x + dx + px, y + dy + py, z) for px, py, z in points)
            self.faces.extend(tuple(first + index for index in face) for face in faces)
            self.indices.extend([shade] * len(faces))

    def ribbon(self, x, y, direction, length, width, arch, shade):
        dx, dy = cos(direction), sin(direction)
        points = [
            (-dy * width, dx * width, 0.0009), (dy * width, -dx * width, 0.0011),
            (dx * length * 0.43 - dy * width * 0.70, dy * length * 0.43 + dx * width * 0.70, arch),
            (dx * length * 0.43 + dy * width * 0.65, dy * length * 0.43 - dx * width * 0.65, arch * 0.81),
            (dx * length - dy * width * 1.1, dy * length + dx * width * 1.1, arch * 0.71),
        ]
        self.mesh(x, y, points, [(0, 1, 3, 2), (2, 3, 4)], shade)

    def pebble(self, x, y, direction, radius, height, shade):
        rim = [(cos(direction + i * tau / 5) * radius, sin(direction + i * tau / 5) * radius * 0.70, 0.001)
               for i in range(5)]
        self.mesh(x, y, [*rim, (radius * 0.14, -radius * 0.20, height)],
                  [(i, (i + 1) % 5, 5) for i in range(5)], shade)

    def object(self):
        mesh = bpy.data.meshes.new(self.name)
        mesh.from_pydata(self.vertices, [], self.faces)
        mesh.update()
        obj = bpy.data.objects.new(self.name, mesh)
        bpy.context.collection.objects.link(obj)
        for index, color in enumerate(self.shades):
            material = bpy.data.materials.new(f"{self.name} {index + 1}")
            material.use_nodes = True
            shader = material.node_tree.nodes.get("Principled BSDF")
            shader.inputs["Base Color"].default_value = (*color, 1)
            shader.inputs["Roughness"].default_value = 0.87
            mesh.materials.append(material)
        mesh.polygons.foreach_set("material_index", self.indices)
        return obj


def meadow_blades():
    rng = Random(95027)
    leaves = Scatter("Bent grass blades", [
        (0.034, 0.099, 0.013), (0.055, 0.178, 0.022), (0.086, 0.249, 0.031),
        (0.142, 0.300, 0.046), (0.225, 0.327, 0.064),
    ])
    for _ in range(4390):
        x, y = rng.uniform(-1, 1), rng.uniform(-1, 1)
        patch = cos(tau * x + sin(tau * y)) * sin(tau * (x + y) * 0.5)
        if rng.random() > 0.91 + patch * 0.18:
            continue
        heading = rng.uniform(0, tau)
        size = rng.uniform(0.008, 0.025)
        for _ in range(rng.randrange(5, 12)):
            leaf_x = (x + rng.uniform(-0.018, 0.018) + 1) % 2 - 1
            leaf_y = (y + rng.uniform(-0.018, 0.018) + 1) % 2 - 1
            leaves.ribbon(leaf_x, leaf_y, heading + rng.uniform(-1.6, 1.6), size * rng.uniform(0.68, 1.64),
                          rng.uniform(0.0011, 0.0034), size * rng.uniform(0.29, 0.81),
                          rng.choices(range(5), [20, 24, 27, 20, 9])[0])
    return leaves.object()


def pine_litter():
    rng = Random(7963)
    litter = Scatter("Pine litter", [
        (0.091, 0.044, 0.014), (0.184, 0.096, 0.031), (0.273, 0.155, 0.058),
        (0.088, 0.126, 0.033), (0.144, 0.147, 0.111),
    ])
    for _ in range(1220):
        x, y = rng.uniform(-1, 1), rng.uniform(-1, 1)
        for _ in range(rng.randrange(3, 8)):
            px = (x + rng.uniform(-0.029, 0.029) + 1) % 2 - 1
            py = (y + rng.uniform(-0.029, 0.029) + 1) % 2 - 1
            litter.ribbon(px, py, rng.uniform(0, tau), rng.uniform(0.009, 0.029),
                          rng.uniform(0.0008, 0.0019), rng.uniform(0.0015, 0.0044),
                          rng.choices(range(4), [29, 33, 20, 18])[0])
    for _ in range(230):
        x, y, heading = rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(0, tau)
        litter.ribbon(x, y, heading, rng.uniform(0.020, 0.057), rng.uniform(0.0025, 0.0046),
                      rng.uniform(0.003, 0.011), rng.choice([0, 1, 1, 2]))
    for _ in range(160):
        radius = rng.uniform(0.004, 0.014)
        litter.pebble(rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(0, tau), radius, radius * 0.46, 4)
    return litter.object()


def sandstone_fragments():
    rng = Random(1373)
    gravel = Scatter("Sandstone fragments", [
        (0.257, 0.138, 0.061), (0.348, 0.211, 0.103), (0.530, 0.366, 0.174),
    ])
    for _ in range(92):
        x, y = rng.uniform(-1, 1), rng.uniform(-1, 1)
        for index in range(rng.randrange(2, 6)):
            px = (x + rng.uniform(-0.043, 0.043) + 1) % 2 - 1
            py = (y + rng.uniform(-0.043, 0.043) + 1) % 2 - 1
            radius = rng.uniform(0.009, 0.021) if index == 0 else rng.uniform(0.003, 0.008)
            gravel.pebble(px, py, rng.uniform(0, tau), radius, radius * rng.uniform(0.29, 0.63), rng.randrange(3))
    return gravel.object()


BAKES = {
    "mountain": (mountain, None, 512),
    "crystal": (crystal, None, 512),
    "grass": (grass, meadow_blades, 1024),
    "forest": (forest, pine_litter, 1024),
    "desert": (desert, sandstone_fragments, 1024),
}


def bake():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 16
    scene.cycles.use_denoising = False
    scene.world.use_nodes = True
    background = scene.world.node_tree.nodes["Background"]
    background.inputs["Color"].default_value = (1, 1, 1, 1)
    background.inputs["Strength"].default_value = 0.65
    scene.view_settings.view_transform = "Standard"
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "JPEG"
    scene.render.image_settings.quality = 93

    bpy.ops.object.camera_add(location=(0, 0, 3), rotation=(0, 0, 0))
    scene.camera = bpy.context.object
    scene.camera.data.type = "ORTHO"
    scene.camera.data.ortho_scale = 2
    bpy.ops.object.light_add(type="SUN")
    sun = bpy.context.object
    sun.rotation_euler = Vector((0.52, -0.43, -1)).to_track_quat("-Z", "Y").to_euler()
    sun.data.energy = 1.45
    sun.data.angle = 0.025
    bpy.ops.mesh.primitive_plane_add(size=6)
    plane = bpy.context.object
    # The camera crops the center tile while its wrapped neighbors still cast shadows.
    for loop in plane.data.uv_layers.active.data:
        loop.uv = loop.uv * 3 - Vector((1, 1))

    ASSETS.mkdir(parents=True, exist_ok=True)
    names = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else BAKES
    for name in names:
        material, scatter, resolution = BAKES[name]
        plane.data.materials.clear()
        plane.data.materials.append(material())
        detail = scatter() if scatter else None
        scene.render.resolution_x = scene.render.resolution_y = resolution
        scene.render.filepath = str(ASSETS / f"{name}.jpg")
        bpy.ops.render.render(write_still=True)
        if detail:
            bpy.data.objects.remove(detail, do_unlink=True)


if __name__ == "__main__":
    bake()
