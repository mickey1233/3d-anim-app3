import cv2
import json
import numpy as np
import os
from scipy.spatial.transform import Rotation as R

INTRINSICS_FILE = "intrinsics.json"
RESULTS_FILE = "results.json"
PARTS_FILE = "correspondences_parts.json"
OVERLAYS_DIR = "cv_agent/overlays"

def to_matrix(rvec, tvec):
    rot_mat, _ = cv2.Rodrigues(np.array(rvec))
    T = np.eye(4)
    T[:3, :3] = rot_mat
    T[:3, 3] = np.array(tvec).flatten()
    return T

def solve_part_pose():
    if not os.path.exists(RESULTS_FILE) or not os.path.exists(PARTS_FILE):
        print("Missing files.")
        return

    with open(INTRINSICS_FILE, 'r') as f:
        intrinsics = json.load(f)
        K = np.array(intrinsics['K'])
        dist = np.array(intrinsics.get('distortion_coeffs', [0,0,0,0,0]))
        
    with open(RESULTS_FILE, 'r') as f:
        results = json.load(f)
        
    with open(PARTS_FILE, 'r') as f:
        parts_data = json.load(f)

    # Map existing images
    img_map = {img['file']: img for img in results['images']}
    
    for entry in parts_data['images']:
        fname = entry['file']
        points = entry['points']
        
        if fname not in img_map:
            print(f"Skipping {fname}: Camera not solved (Base not found).")
            continue
            
        cam_info = img_map[fname].get('camera')
        if not cam_info:
            print(f"Skipping {fname}: No camera info.")
            continue
            
        # Get Camera Transform (World -> Cam)
        # Note: rvec/tvec in results are from solvePnP (World->Cam)
        T_world_cam = to_matrix(cam_info['R'], cam_info['t'])
        
        # Group points by Part ID
        parts_groups = {}
        for p in points:
            pid = p['partId']
            if pid not in parts_groups: parts_groups[pid] = {'p3d':[], 'p2d':[]}
            parts_groups[pid]['p3d'].append(p['p3d'])
            parts_groups[pid]['p2d'].append(p['p2d'])
            
        processed_parts = []
        
        # Load Overlay Image
        img_path = os.path.join("IMAGES", fname)
        img_bgr = cv2.imread(img_path) if os.path.exists(img_path) else None
        
        if img_bgr is not None:
            # Draw World Axis (Base) using T_world_cam (Camera Extrinsics)
            # T_world_cam converts World Point to Camera Point.
            # We want to project (0,0,0) and axes.
            # rvec/tvec in results.json are World->Cam.
            rvec_cam = np.array(cam_info['R'])
            tvec_cam = np.array(cam_info['t'])
            
            # Axis at World Origin
            axis_base = np.float32([[0,0,0], [0.1,0,0], [0,0.1,0], [0,0,0.1]]).reshape(-1,3)
            axis_pts_base, _ = cv2.projectPoints(axis_base, rvec_cam, tvec_cam, K, dist)
            
            o_base = tuple(axis_pts_base[0].ravel().astype(int))
            cv2.line(img_bgr, o_base, tuple(axis_pts_base[1].ravel().astype(int)), (0, 0, 150), 2) # Darker Red
            cv2.line(img_bgr, o_base, tuple(axis_pts_base[2].ravel().astype(int)), (0, 150, 0), 2) # Darker Green
            cv2.line(img_bgr, o_base, tuple(axis_pts_base[3].ravel().astype(int)), (150, 0, 0), 2) # Darker Blue
            cv2.putText(img_bgr, "Base", (o_base[0], o_base[1]+15), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0,150,0), 1)

        for pid, data in parts_groups.items():
            if len(data['p3d']) < 4:
                print(f"Skipping {pid} in {fname}: Not enough points.")
                continue
                
            obj_pts = np.array(data['p3d'], dtype=np.float32)
            img_pts = np.array(data['p2d'], dtype=np.float32)
            
            # Solve Part -> Camera
            success, rvec_part, tvec_part = cv2.solvePnP(obj_pts, img_pts, K, dist, flags=cv2.SOLVEPNP_EPNP)
            
            if success:
                error = 0.0
                # Reprojection Error (Part -> Cam -> Image)
                proj_pts, _ = cv2.projectPoints(obj_pts, rvec_part, tvec_part, K, dist)
                error = cv2.norm(img_pts, proj_pts.reshape(-1, 2), cv2.NORM_L2) / len(proj_pts)
                print(f"Solved {pid}: Reproj Error = {error:.2f} px")
                
                # Compute Part -> World
                # T_part_cam = T_world_cam * T_part_world ?? NO.
                # P_cam = T_world_cam * P_world
                # P_cam = T_part_cam * P_part
                # Assume P_world = T_part_world * P_part ???
                # We want T_part_world.
                # T_world_cam * T_part_world = T_part_cam
                # T_part_world = (T_world_cam)^-1 * T_part_cam
                
                T_part_cam = to_matrix(rvec_part, tvec_part)
                T_cam_world = np.linalg.inv(T_world_cam)
                T_part_world = T_cam_world @ T_part_cam
                
                # Extract Transform
                t_pw = T_part_world[:3, 3]
                rot_pw = T_part_world[:3, :3]
                quat_pw = R.from_matrix(rot_pw).as_quat()
                
                processed_parts.append({
                    "id": pid,
                    "pose_world": {
                        "position": t_pw.tolist(),
                        "quaternion": quat_pw.tolist()
                    },
                    "reproj_error": error
                })
                
                # Draw Overlay
                if img_bgr is not None:
                     # Draw Axis at Centroid of Part
                    centroid = np.mean(obj_pts, axis=0)
                    axis = np.float32([centroid, centroid + [0.1,0,0], centroid + [0,0.1,0], centroid + [0,0,0.1]]).reshape(-1,3)
                    axis_pts, _ = cv2.projectPoints(axis, rvec_part, tvec_part, K, dist) # Project using Part->Cam
                    
                    o = tuple(axis_pts[0].ravel().astype(int))
                    cv2.line(img_bgr, o, tuple(axis_pts[1].ravel().astype(int)), (0, 0, 255), 3)
                    cv2.line(img_bgr, o, tuple(axis_pts[2].ravel().astype(int)), (0, 255, 0), 3)
                    cv2.line(img_bgr, o, tuple(axis_pts[3].ravel().astype(int)), (255, 0, 0), 3)
                    
                    # Draw text
                    cv2.putText(img_bgr, f"{pid} err:{error:.1f}", (o[0], o[1]-10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0,255,255), 1)

        # Update Results
        img_map[fname]['parts'] = processed_parts
        
        # Save Overlay
        if img_bgr is not None:
             cv2.imwrite(os.path.join(OVERLAYS_DIR, f"overlay_{fname}"), img_bgr) # Overwrite existing or Create new? Overwrite is ok (composite)
             
    # Save JSON
    results['images'] = list(img_map.values())
    with open(RESULTS_FILE, 'w') as f:
        json.dump(results, f, indent=2)

if __name__ == "__main__":
    solve_part_pose()
