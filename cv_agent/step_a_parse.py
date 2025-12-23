import trimesh
import json
import numpy as np
import os

CAD_PATH = "CAD/Spark.glb"
OUTPUT_FILE = "cad_analysis.json"

def parse_cad():
    if not os.path.exists(CAD_PATH):
        print(f"Error: CAD file not found at {CAD_PATH}")
        return

    print(f"Loading {CAD_PATH}...")
    # Load simply as scene
    scene = trimesh.load(CAD_PATH, force='scene')
    
    parts_data = {}
    
    # Trimesh scene.geometry stores meshes by name.
    # scene.graph stores the transform hierarchy.
    
    # We want to identify "Parts" (Geometry nodes).
    for node_name in scene.graph.nodes_geometry:
        # Get transform from world to this node
        transform, geometry_name = scene.graph.get(node_name)
        
        # Get the actual mesh
        mesh = scene.geometry[geometry_name]
        
        # Apply transform to a copy to get World Bounds in Rest Pose
        mesh_copy = mesh.copy()
        mesh_copy.apply_transform(transform)
        
        bbox_min = mesh_copy.bounds[0].tolist()
        bbox_max = mesh_copy.bounds[1].tolist()
        center = mesh_copy.centroid.tolist()
        
        parts_data[node_name] = {
            "geometry_name": geometry_name,
            "bbox_min": bbox_min,
            "bbox_max": bbox_max,
            "center": center,
            "features": {
                "vertices_count": len(mesh.vertices),
                "faces_count": len(mesh.faces)
            }
        }

    output = {
        "cad_info": {
            "file": CAD_PATH,
            "units": str(scene.units),
            "up_axis": "Y" # Standard GLTF is Y-up usually
        },
        "parts": parts_data
    }
    
    with open(OUTPUT_FILE, 'w') as f:
        json.dump(output, f, indent=2)
        
    print(f"Analysis complete. Found {len(parts_data)} parts.")
    print(f"Saved to {OUTPUT_FILE}")

if __name__ == "__main__":
    parse_cad()
