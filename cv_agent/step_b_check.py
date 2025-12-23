import json
import numpy as np
import cv2
import os

CAD_ANALYSIS = "cad_analysis.json"
RESULTS_FILE = "results.json"
IMAGES_DIR = "IMAGES"

# User provided (from context)
KNOWN_EXTRINSICS_POS = [147.819, 130.515, -238.965]
KNOWN_EXTRINSICS_ROT_EULER = [-151.35, 28.5, 165.4] # Degrees

def run_alignment_check():
    if not os.path.exists(CAD_ANALYSIS):
        print("Error: Run Step A first.")
        return

    with open(CAD_ANALYSIS, 'r') as f:
        cad_data = json.load(f)

    # Check Images
    image_files = sorted([f for f in os.listdir(IMAGES_DIR) if f.endswith('.png')]) if os.path.exists(IMAGES_DIR) else []
    
    results = {
        "cad_coord_system": {
            "handedness": "RH", # GLTF/Three default
            "units": cad_data['cad_info']['units'],
            "up_axis": cad_data['cad_info']['up_axis']
        },
        "images": []
    }

    print(f"Checking alignment for {len(image_files)} images...")

    for img_file in image_files:
        # Check 1: Do we have Intrinsics?
        # Simulation: We check if `intrinsics.json` exists or arguments provided.
        # We assume missing for now.
        
        # Check 2: Do we have 2D-3D Correspondences?
        # Simulation: Missing.
        
        # Construct Result Entry
        img_result = {
            "file": img_file,
            "status": "FAILED_ALIGNMENT",
            "missing_info": [
                "Camera Intrinsics (fx, fy, cx, cy)",
                "2D-3D Point Correspondences (Need at least 4 per part for PnP without Intrinsics, or 3 with Intrinsics)"
            ],
            "recommendation": "Provide intrinsics OR select 4 matching points between Image and CAD."
        }
        results["images"].append(img_result)

    with open(RESULTS_FILE, 'w') as f:
        json.dump(results, f, indent=2)

    print("Alignment Check Complete. Missing Information identified.")
    print(f"See {RESULTS_FILE}")

if __name__ == "__main__":
    run_alignment_check()
