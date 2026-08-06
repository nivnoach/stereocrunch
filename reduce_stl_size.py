#!/usr/bin/env python3
"""
Reduce STL file size via quadric-decimation (mesh simplification), targeting
a max output size in MB. Binary STL is 84 bytes header + 50 bytes/triangle,
so the target triangle count is derived directly from the target size.

Usage:
    .venv-tools/bin/python3 reduce_stl_size.py --src stl_data --dst stl_data_reduced --target-mb 15
"""
import argparse
import os

import trimesh

HEADER_BYTES = 84
BYTES_PER_TRIANGLE = 50


def target_face_count(target_mb):
    target_bytes = target_mb * 1024 * 1024
    return max(1000, int((target_bytes - HEADER_BYTES) / BYTES_PER_TRIANGLE))


def reduce_file(src_path, dst_path, target_mb):
    mesh = trimesh.load(src_path, force="mesh")
    target_faces = target_face_count(target_mb)

    if len(mesh.faces) <= target_faces:
        mesh.export(dst_path)  # already small enough; just re-save as binary STL
        return len(mesh.faces), len(mesh.faces), False

    simplified = mesh.simplify_quadric_decimation(face_count=target_faces)
    simplified.export(dst_path)
    return len(mesh.faces), len(simplified.faces), True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="stl_data")
    ap.add_argument("--dst", default="stl_data_reduced")
    ap.add_argument("--target-mb", type=float, default=15.0)
    args = ap.parse_args()

    os.makedirs(args.dst, exist_ok=True)
    files = sorted(f for f in os.listdir(args.src) if f.lower().endswith(".stl"))

    for i, fname in enumerate(files, 1):
        src_path = os.path.join(args.src, fname)
        dst_path = os.path.join(args.dst, fname)
        before_size = os.path.getsize(src_path)

        orig_faces, new_faces, was_simplified = reduce_file(src_path, dst_path, args.target_mb)
        after_size = os.path.getsize(dst_path)

        tag = "simplified" if was_simplified else "copied (already small)"
        print(f"[{i}/{len(files)}] {fname}: {before_size/1e6:.1f}MB ({orig_faces} tris) "
              f"-> {after_size/1e6:.1f}MB ({new_faces} tris) [{tag}]")

    print(f"Done. Reduced files written to {args.dst}")


if __name__ == "__main__":
    main()
