"""Rebuild the exact letter-size Floor mat. Requires opencv-contrib-python and reportlab."""
from pathlib import Path
import cv2
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter

output = Path(__file__).resolve().parents[1] / 'apps/admin/public/floor-aruco-mat.pdf'
dictionary = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
c = canvas.Canvas(str(output), pagesize=letter, invariant=1)
c.setTitle('Floor letter-size ArUco measuring mat')
c.setFont('Helvetica-Bold', 15)
c.drawCentredString(306, 761, 'Floor measuring mat')
c.setFont('Helvetica', 9)
c.drawCentredString(306, 746, 'Print US Letter at 100% / Actual Size. Disable Fit to page.')
for marker_id, (x, y) in enumerate([(0.5, 1), (6.5, 1), (0.5, 8.5), (6.5, 8.5)]):
    marker = cv2.aruco.generateImageMarker(dictionary, marker_id, 6)
    for row in range(6):
        for col in range(6):
            if marker[row, col] < 128:
                c.rect(x*72+col*18, 792-y*72-(row+1)*18, 18, 18, stroke=0, fill=1)
    c.setFont('Helvetica', 8)
    c.drawString(x*72, 792-(y+1.5)*72-12, f'ID {marker_id} | 1.50 inch marker')
c.setFont('Helvetica-Bold', 11)
c.drawCentredString(306, 455, 'Keep all four markers visible')
c.setFont('Helvetica', 9)
for y, text in [(435, 'Top: camera directly overhead; select opposite item corners.'),
                (420, 'Side: stand mat upright beside the item in the same plane.'),
                (405, 'Select the bottom and top of the item to measure height.'),
                (380, 'Review measurements before applying. No weight is measured.'),
                (365, 'Use a larger calibrated board or a ruler if the item covers markers.')]:
    c.drawCentredString(306, y, text)
c.line(252, 284, 360, 284)
c.line(252, 280, 252, 288)
c.line(360, 280, 360, 288)
c.drawCentredString(306, 270, 'Check this line measures exactly 1.50 inches')
c.setFont('Helvetica', 8)
c.drawCentredString(306, 32, 'OpenCV ArUco DICT_4X4_50 | Floor mat v1 | Letter 8.5 x 11 inches')
c.showPage()
c.save()
print(output)
