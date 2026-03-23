#!/usr/bin/env python3
"""Convert USD (with gltf/pbr.mdl materials) to GLB with correct PBR materials.

Strategy:
1. Use usd2gltf for geometry conversion (works correctly)
2. Post-process the GLB to replace materials using data extracted from USD MDL shaders
   - base_color_factor → baseColorFactor
   - metallic_factor / roughness_factor → PBR factors
   - child texture shaders → baseColorTexture, metallicRoughnessTexture
"""
import sys
import os
import json
import struct
import shutil
import base64


# ─── MDL material extraction ──────────────────────────────────────────────────

def extract_mdl_materials(stage, src_dir: str) -> dict:
    """
    Return dict: material_name → {
        base_color: [r, g, b],
        metallic: float, roughness: float,
        alpha_mode: int,
        base_color_tex: abs_path | None,
        metallic_roughness_tex: abs_path | None,
        normal_tex: abs_path | None,
    }
    """
    from pxr import UsdShade  # type: ignore

    result = {}

    for prim in stage.Traverse():
        if prim.GetTypeName() != 'Shader':
            continue
        shader = UsdShade.Shader(prim)

        # Check if this is a top-level material shader (parent is a Material)
        parent = prim.GetParent()
        if parent.GetTypeName() != 'Material':
            continue

        mat_name = parent.GetName()
        inputs = {inp.GetBaseName(): inp.Get() for inp in shader.GetInputs() if inp.Get() is not None}

        # Only handle MDL-style shaders with base_color_factor
        if 'base_color_factor' not in inputs and 'metallic_factor' not in inputs:
            continue

        bc = inputs.get('base_color_factor', (1.0, 1.0, 1.0))
        metallic = float(inputs.get('metallic_factor', 0.0))
        roughness = float(inputs.get('roughness_factor', 1.0))
        alpha_mode = int(inputs.get('alpha_mode', 0))
        alpha_cutoff = float(inputs.get('alpha_cutoff', 0.5))
        base_alpha = float(inputs.get('base_alpha', 1.0))

        # Find texture sub-shaders (siblings under same Material prim)
        base_color_tex = None
        metallic_roughness_tex = None
        normal_tex = None

        for child in parent.GetChildren():
            if child.GetTypeName() != 'Shader':
                continue
            child_shader = UsdShade.Shader(child)
            child_inputs = {inp.GetBaseName(): inp for inp in child_shader.GetInputs()}
            tex_input = child_inputs.get('texture')
            if tex_input is None:
                continue
            tex_asset = tex_input.Get()
            if tex_asset is None:
                continue
            tex_path = str(tex_asset.path).lstrip('./')
            abs_tex = os.path.join(src_dir, tex_path)
            if not os.path.isfile(abs_tex):
                # Try just basename in textures/
                abs_tex = os.path.join(src_dir, 'textures', os.path.basename(tex_path))

            child_name = child.GetName().lower()
            if 'basecolor' in child_name or 'diffuse' in child_name or 'albedo' in child_name:
                base_color_tex = abs_tex if os.path.isfile(abs_tex) else None
            elif 'metallic' in child_name or 'met' in child_name or 'roughness' in child_name:
                metallic_roughness_tex = abs_tex if os.path.isfile(abs_tex) else None
            elif 'normal' in child_name:
                normal_tex = abs_tex if os.path.isfile(abs_tex) else None

        result[mat_name] = {
            'base_color': [float(bc[0]), float(bc[1]), float(bc[2])],
            'metallic': metallic,
            'roughness': roughness,
            'alpha_mode': alpha_mode,
            'alpha_cutoff': alpha_cutoff,
            'base_alpha': base_alpha,
            'base_color_tex': base_color_tex,
            'metallic_roughness_tex': metallic_roughness_tex,
            'normal_tex': normal_tex,
        }

    return result


def mesh_to_material_map(stage) -> dict:
    """
    Return dict: mesh_name → list of material names, one per primitive (GeomSubset).
    If no subsets, returns a single-element list with the mesh-level material.
    GLB primitive order matches USD GeomSubset order.
    """
    from pxr import UsdShade, UsdGeom  # type: ignore
    result = {}
    for prim in stage.Traverse():
        if prim.GetTypeName() != 'Mesh':
            continue
        mesh_name = prim.GetName()
        subsets = UsdGeom.Subset.GetAllGeomSubsets(UsdGeom.Imageable(prim))
        if subsets:
            mat_list = []
            for subset in subsets:
                mb = UsdShade.MaterialBindingAPI(subset.GetPrim())
                mat, _ = mb.ComputeBoundMaterial()
                mat_list.append(mat.GetPrim().GetName() if mat else None)
            result[mesh_name] = mat_list
        else:
            mb = UsdShade.MaterialBindingAPI(prim)
            mat, _ = mb.ComputeBoundMaterial()
            if mat:
                result[mesh_name] = [mat.GetPrim().GetName()]
    return result


# ─── GLB binary patching ─────────────────────────────────────────────────────

GLB_MAGIC = 0x46546C67
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN  = 0x004E4942


def read_glb(path: str):
    with open(path, 'rb') as f:
        data = f.read()
    magic, version, total = struct.unpack_from('<III', data, 0)
    assert magic == GLB_MAGIC, 'Not a GLB file'

    offset = 12
    json_chunk_len, json_chunk_type = struct.unpack_from('<II', data, offset)
    assert json_chunk_type == CHUNK_JSON
    json_bytes = data[offset + 8: offset + 8 + json_chunk_len]
    gltf = json.loads(json_bytes)

    offset2 = offset + 8 + json_chunk_len
    bin_data = b''
    if offset2 < len(data):
        bin_chunk_len, bin_chunk_type = struct.unpack_from('<II', data, offset2)
        if bin_chunk_type == CHUNK_BIN:
            bin_data = data[offset2 + 8: offset2 + 8 + bin_chunk_len]

    return gltf, bin_data


def write_glb(path: str, gltf: dict, bin_data: bytes):
    json_bytes = json.dumps(gltf, separators=(',', ':')).encode('utf-8')
    # Pad JSON to 4-byte boundary
    pad = (4 - len(json_bytes) % 4) % 4
    json_bytes += b' ' * pad

    # Pad BIN to 4-byte boundary
    bin_pad = (4 - len(bin_data) % 4) % 4
    bin_data_padded = bin_data + b'\x00' * bin_pad

    total = 12 + 8 + len(json_bytes) + (8 + len(bin_data_padded) if bin_data else 0)
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', GLB_MAGIC, 2, total))
        f.write(struct.pack('<II', len(json_bytes), CHUNK_JSON))
        f.write(json_bytes)
        if bin_data:
            f.write(struct.pack('<II', len(bin_data_padded), CHUNK_BIN))
            f.write(bin_data_padded)


def embed_image_as_buffer_view(gltf: dict, bin_data: bytearray, image_path: str) -> int:
    """Append image file to the BIN chunk, return image index in gltf['images']."""
    with open(image_path, 'rb') as f:
        img_bytes = f.read()

    ext = os.path.splitext(image_path)[1].lower()
    mime = 'image/png' if ext == '.png' else 'image/jpeg'

    # Add buffer view
    bv_idx = len(gltf.setdefault('bufferViews', []))
    byte_offset = len(bin_data)
    gltf['bufferViews'].append({
        'buffer': 0,
        'byteOffset': byte_offset,
        'byteLength': len(img_bytes),
    })
    bin_data += img_bytes

    # Add image
    img_idx = len(gltf.setdefault('images', []))
    gltf['images'].append({'bufferView': bv_idx, 'mimeType': mime})

    # Add texture
    tex_idx = len(gltf.setdefault('textures', []))
    gltf['textures'].append({'source': img_idx})

    return tex_idx


ALPHA_MODE_MAP = {0: 'OPAQUE', 1: 'MASK', 2: 'BLEND'}


def build_gltf_material(gltf: dict, bin_data: bytearray, mat_info: dict) -> dict:
    m: dict = {
        'name': '',
        'pbrMetallicRoughness': {
            'baseColorFactor': mat_info['base_color'] + [mat_info['base_alpha']],
            'metallicFactor': mat_info['metallic'],
            'roughnessFactor': mat_info['roughness'],
        },
        'alphaMode': ALPHA_MODE_MAP.get(mat_info['alpha_mode'], 'OPAQUE'),
        'doubleSided': False,
    }
    if mat_info['alpha_mode'] == 1:
        m['alphaCutoff'] = mat_info['alpha_cutoff']

    if mat_info.get('base_color_tex'):
        tex_idx = embed_image_as_buffer_view(gltf, bin_data, mat_info['base_color_tex'])
        m['pbrMetallicRoughness']['baseColorTexture'] = {'index': tex_idx, 'texCoord': 0}
        # When texture is present, reset factor to white
        m['pbrMetallicRoughness']['baseColorFactor'] = [1.0, 1.0, 1.0, mat_info['base_alpha']]

    if mat_info.get('metallic_roughness_tex'):
        tex_idx = embed_image_as_buffer_view(gltf, bin_data, mat_info['metallic_roughness_tex'])
        m['pbrMetallicRoughness']['metallicRoughnessTexture'] = {'index': tex_idx, 'texCoord': 0}

    if mat_info.get('normal_tex'):
        tex_idx = embed_image_as_buffer_view(gltf, bin_data, mat_info['normal_tex'])
        m['normalTexture'] = {'index': tex_idx, 'texCoord': 0}

    return m


# ─── Main conversion ──────────────────────────────────────────────────────────

def patch_usd2gltf_for_mdl():
    """Prevent usd2gltf from crashing on MDL materials (no UsdPreviewSurface)."""
    try:
        from usd2gltf.converters import usd_material  # type: ignore
        from gltflib import Material, PBRMetallicRoughness  # type: ignore
        original_convert = usd_material.convert

        def safe_convert(converter, usd_mat):
            surf = usd_mat.GetSurfaceOutput()
            connected = surf.GetConnectedSource() if surf else None
            if not connected:
                material_id = len(converter.materials)
                mat_name = usd_mat.GetPrim().GetName()
                gltf_mat = Material(name=mat_name)
                gltf_mat.pbrMetallicRoughness = PBRMetallicRoughness()
                gltf_mat.pbrMetallicRoughness.baseColorFactor = [1, 1, 1, 1]
                gltf_mat.pbrMetallicRoughness.metallicFactor = 0.0
                gltf_mat.emissiveFactor = [0, 0, 0]
                converter.materials.append(gltf_mat)
                return material_id, gltf_mat
            return original_convert(converter, usd_mat)

        usd_material.convert = safe_convert
    except Exception as e:
        print(f'[usd_to_glb] patch warning: {e}', file=sys.stderr)


def extract_usd_node_transforms(stage) -> dict:
    """Extract local TRS from each xformable USD prim.
    Returns dict: prim_name → {translation, rotation (xyzw), scale}.
    Only non-identity transforms are included.
    """
    from pxr import UsdGeom, Gf, Usd  # type: ignore

    result = {}
    time = Usd.TimeCode.Default()

    for prim in stage.Traverse():
        xformable = UsdGeom.Xformable(prim)
        if not xformable:
            continue
        local_mat = xformable.GetLocalTransformation(time)
        mat = Gf.Matrix4d(local_mat)

        trans = mat.ExtractTranslation()

        # Column lengths → scale (pxr mat is row-major: mat[row][col])
        col0 = Gf.Vec3d(mat[0][0], mat[1][0], mat[2][0])
        col1 = Gf.Vec3d(mat[0][1], mat[1][1], mat[2][1])
        col2 = Gf.Vec3d(mat[0][2], mat[1][2], mat[2][2])
        sx, sy, sz = col0.GetLength(), col1.GetLength(), col2.GetLength()

        # Normalize columns to get pure rotation matrix, then extract quaternion.
        # ExtractRotationQuat() uses Shepperd's method on raw matrix entries which
        # gives wrong results when scale != 1 (diagonal gets polluted by scale).
        eps = 1e-10
        norm_mat = Gf.Matrix4d(
            mat[0][0] / (sx or eps), mat[0][1] / (sy or eps), mat[0][2] / (sz or eps), 0.0,
            mat[1][0] / (sx or eps), mat[1][1] / (sy or eps), mat[1][2] / (sz or eps), 0.0,
            mat[2][0] / (sx or eps), mat[2][1] / (sy or eps), mat[2][2] / (sz or eps), 0.0,
            0.0,                     0.0,                     0.0,                     1.0,
        )
        rot_quat = norm_mat.ExtractRotationQuat()
        qw = float(rot_quat.GetReal())
        qi = rot_quat.GetImaginary()
        qx, qy, qz = float(qi[0]), float(qi[1]), float(qi[2])

        is_identity = (
            abs(trans[0]) < 1e-6 and abs(trans[1]) < 1e-6 and abs(trans[2]) < 1e-6 and
            abs(sx - 1.0) < 1e-6 and abs(sy - 1.0) < 1e-6 and abs(sz - 1.0) < 1e-6 and
            abs(qx) < 1e-6 and abs(qy) < 1e-6 and abs(qz) < 1e-6 and abs(qw - 1.0) < 1e-6
        )
        if is_identity:
            continue

        result[prim.GetName()] = {
            'translation': [float(trans[0]), float(trans[1]), float(trans[2])],
            'rotation': [qx, qy, qz, qw],   # GLB xyzw order
            'scale': [float(sx), float(sy), float(sz)],
        }

    return result


def apply_usd_transforms_to_glb(gltf: dict, usd_transforms: dict, meters_per_unit: float) -> int:
    """Apply USD local TRS to matching GLB nodes.
    - Only the FIRST GLB node with each name is updated (avoids applying one USD prim's
      transform to multiple same-named GLB nodes).
    - Translations are multiplied by meters_per_unit to convert to meters.
    - Rotations and scales are transferred as-is (xformOp scale is independent of metersPerUnit).
    Returns match count.
    """
    nodes = gltf.get('nodes', [])
    applied: set = set()
    matched = 0
    for node in nodes:
        name = node.get('name', '')
        if not name or name not in usd_transforms or name in applied:
            continue
        applied.add(name)
        trs = usd_transforms[name]
        node.pop('matrix', None)   # matrix and TRS are mutually exclusive in glTF

        t = [v * meters_per_unit for v in trs['translation']]
        r = trs['rotation']
        s = trs['scale']

        if any(abs(v) > 1e-9 for v in t):
            node['translation'] = t
        if any(abs(v) > 1e-9 for v in r[:3]) or abs(r[3] - 1.0) > 1e-9:
            node['rotation'] = r
        if any(abs(v - 1.0) > 1e-9 for v in s):
            node['scale'] = s

        matched += 1
    return matched


def scale_position_accessors(gltf: dict, bin_data: bytearray, scale: float) -> int:
    """Multiply all POSITION accessor float32 values by `scale` in-place.
    Also updates accessor min/max bounds.  Returns count of accessors scaled.
    """
    accessors = gltf.get('accessors', [])
    buffer_views = gltf.get('bufferViews', [])
    processed: set = set()
    count_scaled = 0

    for mesh in gltf.get('meshes', []):
        for prim in mesh.get('primitives', []):
            acc_idx = prim.get('attributes', {}).get('POSITION')
            if acc_idx is None or acc_idx in processed:
                continue
            processed.add(acc_idx)

            acc = accessors[acc_idx]
            if acc.get('componentType') != 5126:   # 5126 = FLOAT
                continue

            bv_idx = acc.get('bufferView')
            if bv_idx is None:
                continue
            bv = buffer_views[bv_idx]
            byte_offset = bv.get('byteOffset', 0) + acc.get('byteOffset', 0)
            vertex_count = acc['count']
            byte_stride = bv.get('byteStride', 0)

            if byte_stride == 0 or byte_stride == 12:   # tightly packed XYZ float32
                n = vertex_count * 3
                floats = struct.unpack_from(f'<{n}f', bin_data, byte_offset)
                struct.pack_into(f'<{n}f', bin_data, byte_offset, *[v * scale for v in floats])
            else:
                for i in range(vertex_count):
                    off = byte_offset + i * byte_stride
                    x, y, z = struct.unpack_from('<3f', bin_data, off)
                    struct.pack_into('<3f', bin_data, off, x * scale, y * scale, z * scale)

            if 'min' in acc:
                acc['min'] = [v * scale for v in acc['min']]
            if 'max' in acc:
                acc['max'] = [v * scale for v in acc['max']]
            count_scaled += 1

    return count_scaled


def flatten_single_mesh_child_groups(gltf: dict) -> int:
    """Merge intermediate group nodes (no mesh) that have exactly one leaf mesh child
    into that child node.  This ensures extractPartsWithTransforms reads the translation
    from the leaf mesh's own position (not from an invisible parent group).
    Returns number of groups merged.
    """
    nodes = gltf.get('nodes', [])

    # Build parent map: child_idx → parent_idx (-1 = scene root)
    parent_of: dict = {i: -1 for i in range(len(nodes))}  # default: no parent
    for i, n in enumerate(nodes):
        for c in n.get('children', []):
            parent_of[c] = i

    merged = 0
    # Iterate until no more groups can be flattened (handles chained groups)
    changed = True
    while changed:
        changed = False
        for i, group in enumerate(nodes):
            if group.get('mesh') is not None:
                continue   # Already a mesh node
            children = group.get('children', [])
            if len(children) != 1:
                continue
            child_idx = children[0]
            child = nodes[child_idx]
            if child.get('mesh') is None:
                continue   # Child is also a group; handle in next iteration
            if child.get('children'):
                continue   # Child has its own sub-children

            # Move group's TRS to child (child is assumed to have identity TRS from usd2gltf)
            for key in ('translation', 'rotation', 'scale', 'matrix'):
                if key in group:
                    child[key] = group.pop(key)

            # Update group's parent to point directly to child_idx
            p = parent_of.get(i, -1)
            if p >= 0:
                parent = nodes[p]
                parent['children'] = [child_idx if c == i else c for c in parent.get('children', [])]
                parent_of[child_idx] = p
            else:
                for s in gltf.get('scenes', []):
                    s['nodes'] = [child_idx if r == i else r for r in s.get('nodes', [])]

            group['children'] = []   # Orphan the group (harmless for GLB rendering)
            parent_of[i] = -2        # Mark as orphaned to avoid re-processing
            merged += 1
            changed = True

    return merged


def convert(src: str, dst: str) -> None:
    patch_usd2gltf_for_mdl()

    from usd2gltf import converter as u2g  # type: ignore
    from pxr import Usd  # type: ignore

    src_abs = os.path.abspath(src)
    dst_abs = os.path.abspath(dst)
    src_dir = os.path.dirname(src_abs)
    original_cwd = os.getcwd()
    os.chdir(src_dir)

    # Step 1: geometry-only GLB via usd2gltf
    tmp_glb = dst_abs + '.tmp.glb'
    try:
        stage = Usd.Stage.Open(os.path.basename(src_abs))
        c = u2g.Converter()
        c.is_glb = True
        c.process(stage, tmp_glb)
    finally:
        os.chdir(original_cwd)

    if not os.path.exists(tmp_glb) or os.path.getsize(tmp_glb) == 0:
        raise RuntimeError('usd2gltf geometry conversion failed')

    # Step 2: extract MDL materials + USD node transforms from the stage
    print('[usd_to_glb] extracting MDL materials and USD transforms...', file=sys.stderr)
    os.chdir(src_dir)
    try:
        from pxr import UsdGeom as _UsdGeom  # type: ignore
        stage2 = Usd.Stage.Open(os.path.basename(src_abs))
        meters_per_unit = float(_UsdGeom.GetStageMetersPerUnit(stage2) or 1.0)

        # Prefer the companion .usda (text) over the binary .usd/.usdc for material
        # extraction: binary USD may be a trimmed "session" stage that only contains
        # a subset of Looks prims, while the text USDA has the full material library.
        src_basename = os.path.basename(src_abs)
        usda_basename = os.path.splitext(src_basename)[0] + '.usda'
        mat_stage = stage2
        if usda_basename != src_basename and os.path.isfile(usda_basename):
            try:
                mat_stage2 = Usd.Stage.Open(usda_basename)
                n_mats = sum(1 for p in mat_stage2.Traverse() if p.GetTypeName() == 'Material')
                n_mats_orig = sum(1 for p in stage2.Traverse() if p.GetTypeName() == 'Material')
                if n_mats > n_mats_orig:
                    print(f'[usd_to_glb] using {usda_basename} for materials ({n_mats} vs {n_mats_orig})', file=sys.stderr)
                    mat_stage = mat_stage2
            except Exception as e:
                print(f'[usd_to_glb] could not open {usda_basename}: {e}', file=sys.stderr)

        mdl_mats = extract_mdl_materials(mat_stage, src_dir)
        mesh_mat_map = mesh_to_material_map(mat_stage)
        usd_transforms = extract_usd_node_transforms(stage2)
    finally:
        os.chdir(original_cwd)

    print(f'[usd_to_glb] metersPerUnit={meters_per_unit}, {len(mdl_mats)} MDL materials, '
          f'{len(usd_transforms)} non-identity USD transforms', file=sys.stderr)

    # Step 3: patch GLB materials
    gltf, bin_data_bytes = read_glb(tmp_glb)
    bin_data = bytearray(bin_data_bytes)

    # Build material name → index map from existing GLB
    existing_mats = gltf.get('materials', [])
    mat_name_to_idx: dict[str, int] = {m.get('name', ''): i for i, m in enumerate(existing_mats)}

    # Build new materials list
    new_materials = list(existing_mats)  # start with existing (geometry pass may have some)

    # For each MDL material, create a proper glTF material
    mdl_mat_idx: dict[str, int] = {}
    for mat_name, mat_info in mdl_mats.items():
        if mat_name in mat_name_to_idx:
            # Replace existing material in-place
            idx = mat_name_to_idx[mat_name]
            gltf_mat = build_gltf_material(gltf, bin_data, mat_info)
            gltf_mat['name'] = mat_name
            new_materials[idx] = gltf_mat
            mdl_mat_idx[mat_name] = idx
        else:
            # Append new material
            idx = len(new_materials)
            gltf_mat = build_gltf_material(gltf, bin_data, mat_info)
            gltf_mat['name'] = mat_name
            new_materials.append(gltf_mat)
            mdl_mat_idx[mat_name] = idx

    gltf['materials'] = new_materials

    # Re-assign mesh primitives to correct materials using USD GeomSubset order
    if 'meshes' in gltf:
        for mesh in gltf['meshes']:
            mesh_name = mesh.get('name', '')
            mat_list = mesh_mat_map.get(mesh_name)  # list of mat names per primitive
            if not mat_list:
                continue
            primitives = mesh.get('primitives', [])
            for prim_idx, prim in enumerate(primitives):
                if prim_idx < len(mat_list):
                    usd_mat_name = mat_list[prim_idx]
                    if usd_mat_name and usd_mat_name in mdl_mat_idx:
                        prim['material'] = mdl_mat_idx[usd_mat_name]

    # Step 4: usd2gltf does NOT correctly transfer USD XFORM transforms.
    # All nodes come out with identity transforms and vertices in raw USD units.
    # We must post-process: scale vertices → inject transforms → flatten groups.

    # 4a. Scale all POSITION accessor float32 values to meters
    n_scaled = scale_position_accessors(gltf, bin_data, meters_per_unit)
    print(f'[usd_to_glb] scaled {n_scaled} POSITION accessors by {meters_per_unit}', file=sys.stderr)

    # 4b. Inject USD node transforms (first match wins; translations also scaled to meters)
    n_matched = apply_usd_transforms_to_glb(gltf, usd_transforms, meters_per_unit)
    print(f'[usd_to_glb] applied USD transforms to {n_matched} GLB nodes', file=sys.stderr)

    # 4c. Flatten group→leaf-mesh pairs so leaf mesh carries the translation directly.
    # This is required because extractPartsWithTransforms reads the mesh node's LOCAL
    # position — not the parent group's position.
    n_flat = flatten_single_mesh_child_groups(gltf)
    print(f'[usd_to_glb] flattened {n_flat} intermediate group nodes', file=sys.stderr)

    # Update buffer size
    if gltf.get('buffers'):
        gltf['buffers'][0]['byteLength'] = len(bin_data)

    write_glb(dst_abs, gltf, bytes(bin_data))
    os.remove(tmp_glb)

    size_mb = os.path.getsize(dst_abs) / 1024 / 1024
    tex_count = sum(1 for m in mdl_mats.values() if m.get('base_color_tex') or m.get('metallic_roughness_tex'))
    print(f'[usd_to_glb] done → {dst_abs} ({size_mb:.1f}MB, {tex_count} textured materials)', file=sys.stderr)


if __name__ == '__main__':
    if len(sys.argv) != 3:
        print(f'Usage: {sys.argv[0]} <src.usd|usda|usdz> <dst.glb>', file=sys.stderr)
        sys.exit(1)
    convert(sys.argv[1], sys.argv[2])
