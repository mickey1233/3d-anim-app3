import cv2
import json
import numpy as np
import os
from scipy.spatial.transform import Rotation as R

INTRINSICS_FILE = "intrinsics.json"
CORROSPONDENCES_FILE = "correspondences.json"
RESULTS_FILE = "results.json"
IMAGES_DIR = "IMAGES"
OVERLAYS_DIR = "cv_agent/overlays"

def solve_pnp():
    if not os.path.exists(INTRINSICS_FILE) or not os.path.exists(CORROSPONDENCES_FILE):
        print("Missing config files.")
        return

    with open(INTRINSICS_FILE, 'r') as f:
        intrinsics = json.load(f)
        K = np.array(intrinsics['K'])
        dist = np.array(intrinsics.get('distortion_coeffs', [0,0,0,0,0]))
    
    with open(CORROSPONDENCES_FILE, 'r') as f:
        corr_data = json.load(f)

    # Load existing results to update or start fresh
    results = {}
    if os.path.exists(RESULTS_FILE):
        with open(RESULTS_FILE, 'r') as f:
            results = json.load(f)
    else:
        results = {"cad_coord_system": {"handedness": "RH", "units": "meters", "up_axis": "Y"}, "images": []}
    
    # Map existing images by filename for easy update
    img_map = {img['file']: img for img in results['images']}

    os.makedirs(OVERLAYS_DIR, exist_ok=True)

    for img_entry in corr_data['images']:
        fname = img_entry['file']
        points = img_entry['points']
        
        if len(points) < 4:
            print(f"Skipping {fname}: Not enough points ({len(points)} < 4)")
            continue
            
        obj_pts = np.array([p['p3d'] for p in points], dtype=np.float32)
        img_pts = np.array([p['p2d'] for p in points], dtype=np.float32)
        
        # Solve PnP
        # flags=cv2.SOLVEPNP_EPNP (Works with >=4 points)
        success, rvec, tvec = cv2.solvePnP(obj_pts, img_pts, K, dist, flags=cv2.SOLVEPNP_EPNP)
        
        if not success:
            print(f"PnP Failed for {fname}")
            continue
            
        # Reprojection Error
        proj_pts, _ = cv2.projectPoints(obj_pts, rvec, tvec, K, dist)
        error = cv2.norm(img_pts, proj_pts.reshape(-1, 2), cv2.NORM_L2) / len(proj_pts)
        
        print(f"Solved {fname}: Reproj Error = {error:.2f} px")
        
        # Convert Rotation
        rot_mat, _ = cv2.Rodrigues(rvec)
        # Camera Position in World: C = -R^T * t
        cam_pos = -rot_mat.T @ tvec
        # Quaternion (scipy uses scalar last x,y,z,w by default? No, lets check convention)
        # results schema wants [qx, qy, qz, qw] usually.
        # Scipy as_quat() returns [x, y, z, w].
        quat = R.from_matrix(rot_mat).as_quat()
        
        # Update Result
        cam_data = {
            "K": K.tolist(),
            "R": rvec.flatten().tolist(), # Store rvec for simplicity or 3x3
            # Schema requested "R" and "t". Using rvec/tvec is standard OpenCV but maybe User wants Matrix?
            # User example: "R":[...], "t":[...]
            # I will store rvec/tvec lists.
            "t": tvec.flatten().tolist(),
            "reproj_error_px": float(error),
            "pose_world": {
                "position": cam_pos.flatten().tolist(),
                "quaternion": quat.tolist() # [x,y,z,w]
            }
        }
        
        # GENERATE EVIDENCE OVERLAY
        # Draw axes at origin (0,0,0) and at each point
        img_path = os.path.join(IMAGES_DIR, fname)
        if os.path.exists(img_path):
            img_bgr = cv2.imread(img_path)
            
            # Draw Points
            for i, (p_in, p_proj) in enumerate(zip(img_pts, proj_pts.reshape(-1, 2))):
                cv2.circle(img_bgr, (int(p_in[0]), int(p_in[1])), 5, (0, 255, 0), -1) # Green: Ground Truth
                cv2.circle(img_bgr, (int(p_proj[0]), int(p_proj[1])), 3, (0, 0, 255), -1) # Red: Projected
                cv2.line(img_bgr, (int(p_in[0]), int(p_in[1])), (int(p_proj[0]), int(p_proj[1])), (255, 0, 0), 1)
            
            # Draw Axis at Centroid of points (to ensure it's in view)
            centroid = np.mean(obj_pts, axis=0)
            axis = np.float32([centroid, centroid + [0.1,0,0], centroid + [0,0.1,0], centroid + [0,0,0.1]]).reshape(-1,3)
            axis_pts, _ = cv2.projectPoints(axis, rvec, tvec, K, dist)
            
            o = tuple(axis_pts[0].ravel().astype(int))
            cv2.line(img_bgr, o, tuple(axis_pts[1].ravel().astype(int)), (0, 0, 255), 3) # X - Red
            cv2.line(img_bgr, o, tuple(axis_pts[2].ravel().astype(int)), (0, 255, 0), 3) # Y - Green
            cv2.line(img_bgr, o, tuple(axis_pts[3].ravel().astype(int)), (255, 0, 0), 3) # Z - Blue
            
            overlay_path = os.path.join(OVERLAYS_DIR, f"overlay_{fname}")
            cv2.imwrite(overlay_path, img_bgr)
            
            # Update image entry
            if fname in img_map:
                img_map[fname].update({
                    "status": "SOLVED",
                    "camera": cam_data,
                    "evidence": {"overlay": overlay_path}
                })
            else:
                img_map[fname] = {
                    "file": fname,
                    "status": "SOLVED",
                    "camera": cam_data,
                    "evidence": {"overlay": overlay_path},
                    "parts": [] # Todo: Step B3 (Parts)
                }

    # Reconstruct results list
    results['images'] = list(img_map.values())
    
    with open(RESULTS_FILE, 'w') as f:
        json.dump(results, f, indent=2)

    print("Step B2 Complete.")

if __name__ == "__main__":
    solve_pnp()
