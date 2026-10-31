"""
generate_sample_resume.py
-----------------------------------------------------------------------
Generates test/sample_resume.pdf — a realistic, text-based resume PDF
used to demo the resume parser end-to-end without needing a real
candidate's resume on hand. Run once with:

    python3 test/generate_sample_resume.py

Feel free to edit the RESUME dict below to use your own real resume
content for a more convincing mentor demo.
-----------------------------------------------------------------------
"""

from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
from reportlab.lib.enums import TA_LEFT
import os

OUT_PATH = os.path.join(os.path.dirname(__file__), "sample_resume.pdf")

styles = getSampleStyleSheet()
name_style = ParagraphStyle("Name", parent=styles["Title"], fontSize=18, alignment=TA_LEFT, spaceAfter=2)
contact_style = ParagraphStyle("Contact", parent=styles["Normal"], fontSize=10, textColor="#444444", spaceAfter=10)
heading_style = ParagraphStyle("SectionHeading", parent=styles["Heading2"], fontSize=12, spaceBefore=12, spaceAfter=4, textColor="#1a1a1a")
body_style = ParagraphStyle("Body", parent=styles["Normal"], fontSize=10, leading=14, spaceAfter=6)
entry_title_style = ParagraphStyle("EntryTitle", parent=styles["Normal"], fontSize=10.5, leading=14, spaceBefore=6, textColor="#000000")

story = []

story.append(Paragraph("Rohan Deshmukh", name_style))
story.append(Paragraph("rohan.deshmukh@example.com | +91 9876543210 | linkedin.com/in/rohandeshmukh", contact_style))

story.append(Paragraph("Skills", heading_style))
story.append(Paragraph(
    "Languages: Python, JavaScript, Java, SQL<br/>"
    "Web &amp; Backend: React.js, Node.js, Express.js, REST APIs<br/>"
    "Data &amp; ML: Pandas, NumPy, scikit-learn, TensorFlow<br/>"
    "Databases &amp; Tools: MongoDB, MySQL, Git, Docker",
    body_style
))

story.append(Paragraph("Projects", heading_style))
story.append(Paragraph("Campus Event Management Platform", entry_title_style))
story.append(Paragraph(
    "Built a full-stack web application for managing college events, including registration, "
    "attendance tracking and automated certificate generation for over 500 students.",
    body_style
))
story.append(Paragraph("Tech: React, Node.js, Express, MongoDB", body_style))

story.append(Paragraph("Real-Time Chat Application with Sentiment Analysis", entry_title_style))
story.append(Paragraph(
    "Developed a real-time chat app using WebSockets and integrated a sentiment analysis model "
    "to flag potentially toxic messages before delivery.",
    body_style
))
story.append(Paragraph("Tech: Python, Flask, Socket.IO, scikit-learn", body_style))

story.append(Paragraph("Experience", heading_style))
story.append(Paragraph("Software Engineering Intern - Acme Analytics Pvt Ltd", entry_title_style))
story.append(Paragraph("Jun 2025 - Aug 2025", body_style))
story.append(Paragraph(
    "- Built and shipped 4 internal dashboard features using React and REST APIs.<br/>"
    "- Reduced average API response time by 30% by optimising MongoDB queries and adding indexes.<br/>"
    "- Wrote unit tests that raised backend test coverage from 40% to 72%.",
    body_style
))

story.append(Paragraph("Education", heading_style))
story.append(Paragraph("B.Tech in Computer Engineering - MIT World Peace University, Pune", entry_title_style))
story.append(Paragraph("2022 - 2026, CGPA: 8.7/10", body_style))
story.append(Paragraph("Higher Secondary Certificate (HSC) - Science - Fergusson College, Pune", entry_title_style))
story.append(Paragraph("2020 - 2022, 91%", body_style))

story.append(Paragraph("Certifications", heading_style))
story.append(Paragraph("AWS Cloud Practitioner - Amazon Web Services, 2025", body_style))
story.append(Paragraph("Machine Learning Specialization - DeepLearning.AI / Coursera, 2024", body_style))

doc = SimpleDocTemplate(
    OUT_PATH, pagesize=A4,
    topMargin=20 * mm, bottomMargin=20 * mm, leftMargin=20 * mm, rightMargin=20 * mm,
)
doc.build(story)
print(f"Sample resume written to: {OUT_PATH}")
