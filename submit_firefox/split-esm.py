"""
split-esm.py
------------
Splits a large Parcel bundle (>5MB) into two files that each stay under 5MB.
Used to comply with Firefox AMO's 5MB-per-file parse limit.

Usage:
    python split-esm.py <input_file> [split_target_mb]

    input_file      - path to the Parcel bundle JS file (e.g. esm-19.66294edf.js)
    split_target_mb - desired size of part1 in MB (default: 3.7)

Output:
    <name>.part1.<hash>.js  - first half, loaded via <script> tag in sandbox.html
    <name>.<hash>.js        - second half, replaces the original file (keeps original filename)

Example:
    python split-esm.py esm-19.66294edf.js 3.7

How it works:
    Parcel bundles use a module registry pattern. Each module is registered as:
        "moduleId": [function(require, module, exports){ ... }, { deps }]
    The runtime supports a "parent chain": when a second bundle with the same
    parcelRequire name loads, it saves the existing loader as its parent.
    Module lookups fall back up the chain, so modules from part1 remain
    accessible after part2 loads.

    Load order in sandbox.html:
        1. <script src="/esm-19.part1.*.js">  -> registers first half of modules
        2. <script src="/tabs/sandbox.*.js" defer>  -> loads main app
        3. sandbox.js dynamically loads esm-19.*.js  -> registers second half,
           parent chain: part2 -> sandbox -> part1
"""

import re
import sys
import os


def split_parcel_bundle(input_path, split_target_mb=3.7):
    with open(input_path, 'rb') as f:
        data = f.read()

    total = len(data)
    print(f"Input:  {input_path}")
    print(f"Size:   {total} bytes ({total / 1048576:.2f} MB)")

    if total <= 5 * 1048576:
        print("File is already under 5MB, no split needed.")
        return

    # ---------------------------------------------------------------
    # Locate the modules object boundaries
    # Structure: <runtime_iife>({ moduleId: [fn, deps], ... }, [], 0, "parcelRequire...")
    # ---------------------------------------------------------------
    modules_start = data.find(b'}({')
    if modules_start == -1:
        raise ValueError("Cannot find Parcel modules object start (pattern '}({')")
    modules_start += 2  # position of the opening '{'

    end_pattern = rb'\},\[\],\d+,\"parcelRequire[^"]*\"\),globalThis\.define=t;'
    end_match = re.search(end_pattern, data)
    if not end_match:
        raise ValueError("Cannot find Parcel bundle footer pattern")
    modules_end = end_match.start() + 1  # position just after the closing '}'

    preamble = data[:modules_start]
    footer = data[modules_end:]

    print(f"Runtime preamble: {len(preamble)} bytes")
    print(f"Modules object:   {modules_end - modules_start} bytes")
    print(f"Footer:           {len(footer)} bytes")

    # ---------------------------------------------------------------
    # Find a module boundary near the target split point
    # Module boundaries look like:  ],"moduleId":[function(
    # ---------------------------------------------------------------
    boundary_pattern = rb'\],\"([A-Za-z0-9_]+)\":\[function\('
    matches = list(re.finditer(boundary_pattern, data))
    print(f"Module boundaries found: {len(matches)}")

    target_bytes = int(split_target_mb * 1048576)
    best = min(matches, key=lambda m: abs(m.start() - target_bytes))
    split_pos = best.start() + 1  # keep the ']', split before ',"moduleId"'

    print(f"Split point: offset {split_pos} ({split_pos / 1048576:.2f} MB), "
          f"module '{best.group(1).decode()}'")

    # ---------------------------------------------------------------
    # Build part1 and part2
    # part1: preamble + { ...first half modules... } + footer
    # part2: preamble + { ...second half modules... } + footer
    # ---------------------------------------------------------------
    part1_modules = data[modules_start: split_pos + 1] + b'}'
    part2_modules = data[split_pos + 1: modules_end]

    # part2 starts with ,"id":... — remove the leading comma to get valid JS object
    if part2_modules[1:2] == b',':
        part2_modules = b'{' + part2_modules[2:]
    else:
        part2_modules = b'{' + part2_modules

    part1_data = preamble + part1_modules + footer
    part2_data = preamble + part2_modules + footer

    print(f"\nPart1 size: {len(part1_data)} bytes ({len(part1_data) / 1048576:.2f} MB)")
    print(f"Part2 size: {len(part2_data)} bytes ({len(part2_data) / 1048576:.2f} MB)")

    if len(part1_data) > 5 * 1048576:
        print("WARNING: part1 exceeds 5MB! Try a smaller split_target_mb value.")
    if len(part2_data) > 5 * 1048576:
        print("WARNING: part2 exceeds 5MB! Try a larger split_target_mb value.")

    # ---------------------------------------------------------------
    # Derive output filenames
    # Input:  esm-19.66294edf.js
    # Part1:  esm-19.part1.66294edf.js  (new file, added to sandbox.html)
    # Part2:  esm-19.66294edf.js        (replaces original, keeps dynamic import ref)
    # ---------------------------------------------------------------
    dir_name = os.path.dirname(input_path)
    base_name = os.path.basename(input_path)       # esm-19.66294edf.js
    name_no_ext = base_name[:-3]                   # esm-19.66294edf
    first_dot = name_no_ext.index('.')             # position of first '.'
    prefix = name_no_ext[:first_dot]               # esm-19
    suffix = name_no_ext[first_dot + 1:]           # 66294edf

    part1_name = f"{prefix}.part1.{suffix}.js"     # esm-19.part1.66294edf.js
    part2_name = base_name                          # esm-19.66294edf.js (same as input)

    part1_path = os.path.join(dir_name, part1_name) if dir_name else part1_name
    part2_path = input_path  # overwrite original

    # Back up original before overwriting
    backup_path = input_path + '.bak'
    os.rename(input_path, backup_path)
    print(f"\nBacked up original to: {backup_path}")

    with open(part1_path, 'wb') as f:
        f.write(part1_data)
    print(f"Written part1: {part1_path}")

    with open(part2_path, 'wb') as f:
        f.write(part2_data)
    print(f"Written part2: {part2_path}")

    print(f"\nNext step:")
    print(f"  Add to sandbox.html, BEFORE the existing <script> tags:")
    print(f'  <script src="/{part1_name}"></script>')
    print(f"  (The dynamic import reference to '{base_name}' remains unchanged.)")


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python split-esm.py <input_file> [split_target_mb]")
        print("Example: python split-esm.py esm-19.66294edf.js 3.7")
        sys.exit(1)

    input_file = sys.argv[1]
    target_mb = float(sys.argv[2]) if len(sys.argv) >= 3 else 3.7

    split_parcel_bundle(input_file, target_mb)
