import sys
import os
import trimesh
import numpy as np
import shutil
from pxr import Usd, UsdGeom, Sdf, Gf, Vt, UsdUtils, UsdShade

def convert_to_usd(input_path, output_path):
    print(f"Converting {input_path} to {output_path}...")
    
    if not output_path.endswith(".usdz"):
        output_path = os.path.splitext(output_path)[0] + ".usdz"

    # Intermediate USDC file
    base_name = os.path.splitext(os.path.basename(output_path))[0]
    # We need a temp directory to hold textures for packaging
    temp_dir = f"temp_usd_{base_name}"
    if os.path.exists(temp_dir):
        shutil.rmtree(temp_dir)
    os.makedirs(temp_dir)
    
    temp_usd = os.path.join(temp_dir, f"{base_name}.usda")
    
    # Load scene
    mesh_or_scene = trimesh.load(input_path)
    
    # Create Stage
    stage = Usd.Stage.CreateNew(temp_usd)
    UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.y)
    UsdGeom.SetStageMetersPerUnit(stage, 1.0)
    
    root_prim = UsdGeom.Xform.Define(stage, '/Root')
    stage.SetDefaultPrim(root_prim.GetPrim())

    meshes = []
    if isinstance(mesh_or_scene, trimesh.Scene):
        meshes = mesh_or_scene.dump(concatenate=False)
    else:
        meshes = [mesh_or_scene]

    # Create Materials Scope
    UsdGeom.Scope.Define(stage, '/Root/Materials')

    for i, mesh in enumerate(meshes):
        name = f"Mesh_{i}"
        prim_path = f"/Root/{name}"
        usd_mesh = UsdGeom.Mesh.Define(stage, prim_path)

        # Geometry
        points = mesh.vertices
        usd_mesh.GetPointsAttr().Set(Vt.Vec3fArray.FromNumpy(points.astype(np.float32)))
        counts = np.full(len(mesh.faces), 3)
        usd_mesh.GetFaceVertexCountsAttr().Set(Vt.IntArray.FromNumpy(counts.astype(np.int32)))
        indices = mesh.faces.flatten()
        usd_mesh.GetFaceVertexIndicesAttr().Set(Vt.IntArray.FromNumpy(indices.astype(np.int32)))
        
        # Normals
        try:
             normals = mesh.vertex_normals
             if normals is not None and len(normals) == len(points):
                usd_mesh.GetNormalsAttr().Set(Vt.Vec3fArray.FromNumpy(normals.astype(np.float32)))
        except:
            pass

        # UVs (TexCoords)
        try:
            uvs = mesh.visual.uv
            if uvs is not None and len(uvs) == len(points):
                 # Create Primvar 'st'
                 pv = UsdGeom.PrimvarsAPI(usd_mesh).CreatePrimvar("st", Sdf.ValueTypeNames.Float2Array, UsdGeom.Tokens.vertex)
                 pv.Set(Vt.Vec2fArray.FromNumpy(uvs.astype(np.float32)))
        except:
            pass

        # Material Processing
        try:
            mat = mesh.visual.material
            if hasattr(mat, 'main_color') or hasattr(mat, 'baseColorFactor'):
                 # Simple color extraction
                 color = getattr(mat, 'baseColorFactor', None) 
                 if color is None: color = getattr(mat, 'main_color', [0.8, 0.8, 0.8, 1.0])
                 
                 # Ensure color is 3 or 4 elements
                 if len(color) > 3: color = color[:3]
                 
                 # Create Material Prim
                 mat_path = f"/Root/Materials/Mat_{i}"
                 usd_mat = UsdShade.Material.Define(stage, mat_path)
                 pbr_shader = UsdShade.Shader.Define(stage, f"{mat_path}/PBRShader")
                 pbr_shader.CreateIdAttr("UsdPreviewSurface")
                 
                 # Connect Shader to Material
                 usd_mat.CreateSurfaceOutput().ConnectToSource(pbr_shader.ConnectableAPI(), "surface")

                 # Set Diffuse Color
                 # Handle uint8 vs float
                 if color is not None:
                     final_color = [0.8, 0.8, 0.8] # Default

                     # If numpy array
                     if hasattr(color, 'dtype') and np.issubdtype(color.dtype, np.integer):
                         final_color = (color.astype(float) / 255.0).tolist()
                     elif hasattr(color, 'dtype') and np.issubdtype(color.dtype, np.floating):
                         final_color = color.tolist()
                     # If list of ints
                     elif isinstance(color, (list, tuple)):
                         if any(c > 1.0 for c in color):
                             final_color = [float(c) / 255.0 for c in color]
                         else:
                             final_color = [float(c) for c in color]
                     
                     # Ensure it's 3 elements
                     if len(final_color) > 3: final_color = final_color[:3]
                     if len(final_color) < 3: final_color = [final_color[0], final_color[0], final_color[0]]

                     pbr_shader.CreateInput("diffuseColor", Sdf.ValueTypeNames.Color3f).Set(Gf.Vec3f(*final_color))
                 
                 # Textures?
                 # Trimesh stores PIL image in baseColorTexture?
                 if hasattr(mat, 'baseColorTexture') and mat.baseColorTexture:
                     # Save texture
                     tex_name = f"tex_{i}.png"
                     tex_path = os.path.join(temp_dir, tex_name)
                     mat.baseColorTexture.save(tex_path)
                     
                     # Create UV Reader
                     uv_reader = UsdShade.Shader.Define(stage, f"{mat_path}/uvReader")
                     uv_reader.CreateIdAttr("UsdPrimvarReader_float2")
                     uv_reader.CreateInput("varname", Sdf.ValueTypeNames.Token).Set("st")
                     
                     # Create Texture Sampler
                     tex_sampler = UsdShade.Shader.Define(stage, f"{mat_path}/diffuseTexture")
                     tex_sampler.CreateIdAttr("UsdUVTexture")
                     tex_sampler.CreateInput("file", Sdf.ValueTypeNames.Asset).Set(tex_name)
                     tex_sampler.CreateInput("st", Sdf.ValueTypeNames.Float2).ConnectToSource(uv_reader.ConnectableAPI(), "result")
                     
                     # Connect to Diffuse
                     pbr_shader.CreateInput("diffuseColor", Sdf.ValueTypeNames.Color3f).ConnectToSource(tex_sampler.ConnectableAPI(), "rgb")

                 # Bind Material to Mesh
                 UsdShade.MaterialBindingAPI(usd_mesh).Bind(usd_mat)
                 
        except Exception as e:
            print(f"Material Error on mesh {i}: {e}")
            
    stage.GetRootLayer().Save()
    
    stage.GetRootLayer().Save()
    
    # Debug: Check prims
    print("Debug: Stage Traverse:")
    count = 0
    for prim in stage.Traverse():
        print(f" - {prim.GetPath()} ({prim.GetTypeName()})")
        count += 1
    print(f"Total Prims in {temp_usd}: {count}")

    # Package
    print(f"Packaging {temp_dir} to {output_path}...")
    UsdUtils.CreateNewUsdzPackage(Sdf.AssetPath(temp_usd), output_path)
    
    # Cleanup
    if os.path.exists(temp_dir):
        shutil.rmtree(temp_dir)
        
    print(f"Conversion complete: {output_path}")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python convert_to_usd.py <input> <output>")
        sys.exit(1)
    
    try:
        convert_to_usd(sys.argv[1], sys.argv[2])
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)
