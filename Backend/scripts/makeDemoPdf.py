# Builds samples/demo-quick-guideline.pdf: python3 scripts/makeDemoPdf.py samples/demo-quick-guideline.pdf (needs reportlab).
"""Two-page demo guideline: every question asked of every child, dose bands = cut-off bands, quoted referral steps."""
import sys
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.pdfgen import canvas

OUT = sys.argv[1]
W, H = A4
M = 50
c = canvas.Canvas(OUT, pagesize=A4)
c.setTitle("Cough and Fast Breathing in Children - Quick Demo Chart")
c.setAuthor("Demo Community Health Programme")

def header(page):
    c.setFillColor(colors.HexColor("#006194")); c.rect(0, H - 70, W, 70, fill=1, stroke=0)
    c.setFillColor(colors.white); c.setFont("Helvetica-Bold", 17)
    c.drawString(M, H - 42, "Cough and Fast Breathing in Children")
    c.setFont("Helvetica", 10); c.drawRightString(W - M, H - 42, f"Page {page} of 2")
    c.setFillColor(colors.black)

def lines(x, y, items, size=11, lead=16, font="Helvetica"):
    c.setFont(font, size)
    for t in items:
        if isinstance(t, tuple):
            c.setFont(t[1], size); c.drawString(x, y, t[0]); c.setFont(font, size)
        else:
            c.drawString(x, y, t)
        y -= lead
    return y

def box(y, h, fill, edge, title, body):
    c.setFillColor(colors.HexColor(fill)); c.setStrokeColor(colors.HexColor(edge)); c.setLineWidth(1.5)
    c.roundRect(M, y - h, W - 2 * M, h, 8, fill=1, stroke=1)
    c.setFillColor(colors.HexColor(edge)); c.setFont("Helvetica-Bold", 13); c.drawString(M + 14, y - 22, title)
    c.setFillColor(colors.black)
    lines(M + 14, y - 42, body)
    return y - h - 16

# ---------------- page 1 ----------------
header(1)
y = H - 100
c.setFont("Helvetica-Bold", 14); c.drawString(M, y, "Quick Demo Chart for Community Health Workers"); y -= 22
y = lines(M, y, [
    "Publisher: Demo Community Health Programme",
    "Edition: 1.0, November 2026",
    ("For software demonstration only. Not for clinical use.", "Helvetica-Oblique"),
], size=11)
y -= 10
y = box(y, 108, "#EAF4FB", "#006194", "WHO THIS CHART IS FOR", [
    "Use this chart for a child age 2 months up to 5 years.",
    "If the child is younger than 2 months, or 5 years or older, do not use this chart.",
    "Refer the child to the health facility with a referral note.",
    "Follow up on return to the health worker.",
])
y = box(y, 196, "#FFFFFF", "#333333", "ASK AND LOOK: do every step for every child", [
    "1. Ask: Does the child have a cough?",
    "2. Ask: Has the child had convulsions?",
    "3. Ask: Is the child not able to drink or breastfeed?",
    "4. Look: Does the child have chest indrawing?",
    "5. Count the breaths in one minute.",
    "6. Ask the child's age in months (this chart is for age 2 months up to 5 years).",
    "",
    "Ask every question above for every child, in this order, whatever the earlier answers.",
])
y = box(y, 112, "#FFF8E1", "#8A6D00", "DANGER SIGNS AND FAST BREATHING", [
    "Danger signs: convulsions, not able to drink or breastfeed, chest indrawing.",
    "Fast breathing:",
    "   Age 2 months up to 12 months: 50 breaths per minute or more.",
    "   Age 12 months up to 5 years: 40 breaths per minute or more.",
])
c.setFont("Helvetica-Oblique", 9); c.drawString(M, 40, "Go to page 2 to decide and treat.")
c.showPage()

# ---------------- page 2 ----------------
header(2)
y = H - 100
c.setFont("Helvetica-Bold", 14); c.drawString(M, y, "DECIDE AND TREAT"); y -= 18
y = lines(M, y, ["Check the boxes in this order. Use the first box that applies to the child."], size=11)
y -= 6
y = box(y, 94, "#FDECEC", "#B3261E", "1. ANY DANGER SIGN", [
    "If the child has any danger sign:",
    "Refer the child to the health facility immediately.",
    "Follow up on return from the health facility.",
])
y = box(y, 150, "#FFF8E1", "#8A6D00", "2. FAST BREATHING, NO DANGER SIGN", [
    "If the child has fast breathing and no danger sign:",
    "Treat at home: give oral amoxicillin 250 mg tablet twice daily for 5 days, the dose by age being",
    "Age 2 months up to 12 months \u2013 1 tablet; Age 12 months up to 5 years \u2013 2 tablets.",
    "Follow up in 3 days.",
])
y = box(y, 112, "#E3F6EA", "#13693A", "3. COUGH, NO FAST BREATHING, NO DANGER SIGN", [
    "If the child has a cough, no fast breathing and no danger sign:",
    "Give home care advice: keep giving fluids and food, soothe the throat with warm drinks.",
    "Advise the caregiver to come back if the child gets worse.",
])
y = box(y, 104, "#F2F4F7", "#475467", "4. NO COUGH, NO FAST BREATHING, NO DANGER SIGN", [
    "If none of the boxes above applies:",
    "No treatment is needed.",
    "Advise the caregiver to come back if the child gets sick.",
])
c.setFont("Helvetica-Oblique", 9); c.drawString(M, 40, "Demo Community Health Programme, Edition 1.0. For software demonstration only. Not for clinical use.")
c.showPage()
c.save()
print("wrote", OUT)
