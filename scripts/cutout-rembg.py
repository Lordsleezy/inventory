"""Cut out the subject. stdin unused. argv: infile outfile"""
import sys
from pathlib import Path

try:
    from rembg import remove
except ImportError:
    sys.stderr.write("Install rembg in Python: py -3 -m pip install rembg onnxruntime pillow\n")
    sys.exit(2)

if len(sys.argv) != 3:
    sys.stderr.write("Usage: cutout-rembg.py infile outfile\n")
    sys.exit(2)

inp = Path(sys.argv[1])
out = Path(sys.argv[2])
out.write_bytes(remove(inp.read_bytes()))
