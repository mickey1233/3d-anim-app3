import cv2
import json
import os
import glob
import numpy as np

IMAGES_DIR = "IMAGES"
OUTPUT_FILE = "intrinsics.json"
ESTIMATED_HFOV_DEG = 60.0

def estimate_intrinsics():
    img_files = glob.glob(os.path.join(IMAGES_DIR, "*.png"))
    if not img_files:
        print("No images found to estimate intrinsics.")
        return

    # Read first image to get dimensions
    img = cv2.imread(img_files[0])
    h, w = img.shape[:2]
    
    # Calculate Focal Length
    # f = (0.5 * w) / tan(0.5 * hfov)
    fov_rad = np.deg2rad(ESTIMATED_HFOV_DEG)
    f = (0.5 * w) / np.tan(0.5 * fov_rad)
    
    K = [
        [f, 0, w/2],
        [0, f, h/2],
        [0, 0, 1]
    ]
    
    data = {
        "width": w,
        "height": h,
        "K": K,
        "K_flat": [f, 0, w/2, 0, f, h/2, 0, 0, 1],
        "distortion_coeffs": [0,0,0,0,0], # Assume zero distortion for estimation
        "note": f"Estimated based on HFOV {ESTIMATED_HFOV_DEG} deg"
    }
    
    with open(OUTPUT_FILE, 'w') as f:
        json.dump(data, f, indent=2)
        
    print(f"Intrinsics estimated using {img_files[0]} ({w}x{h}). Saved to {OUTPUT_FILE}")

if __name__ == "__main__":
    estimate_intrinsics()
