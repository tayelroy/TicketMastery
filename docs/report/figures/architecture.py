"""Draws the two architecture figures of the report as SVG (target HA design, deployed implementation).

The Mermaid versions laid ~30 services out in one long column, which is unreadable on an A4 page, so this places
every box by hand on a landscape grid. Run from docs/report/figures:  python3 architecture.py
Writes target-ha-architecture.svg and implementation-architecture.svg (embedded in report.md).
"""

from html import escape

W, H = 1700, 810
FONT = "Helvetica, Arial, sans-serif"

# Fill colours per group, kept light so black text stays readable in print.
EDGE, API, VPC, PUBLIC, PRIVATE, ASYNC, OPS, DESIGN = (
    "#fdf2f8", "#ecfeff", "#f0f9ff", "#f0fdf4", "#eef2ff", "#fff7ed", "#f5f3ff", "#f3f4f6")


class Svg:
    def __init__(self, title):
        self.parts = []
        self.title = title

    def group(self, x, y, w, h, label, fill, dash=False):
        style = ' stroke-dasharray="8 5"' if dash else ""
        self.parts.append(
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="{fill}" stroke="#64748b" '
            f'stroke-width="1.5"{style}/>'
            f'<text x="{x + 10}" y="{y + 22}" font-size="17" font-weight="bold" fill="#334155">{escape(label)}</text>')

    def node(self, x, y, w, h, lines, fill="#ffffff", bold_first=True, dash=False):
        style = ' stroke-dasharray="6 4"' if dash else ""
        self.parts.append(
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="6" fill="{fill}" stroke="#1e293b" '
            f'stroke-width="1.4"{style}/>')
        n = len(lines)
        top = y + h / 2 - (n - 1) * 10
        for i, line in enumerate(lines):
            weight = "bold" if (i == 0 and bold_first) else "normal"
            size = 16 if i == 0 else 14
            self.parts.append(
                f'<text x="{x + w / 2}" y="{top + i * 20 + 5}" font-size="{size}" font-weight="{weight}" '
                f'text-anchor="middle" fill="#0f172a">{escape(line)}</text>')
        return (x, y, w, h)

    def arrow(self, points, label=None, dashed=False, label_at=0.5, label_dy=-6):
        d = " ".join(f"{'M' if i == 0 else 'L'}{px},{py}" for i, (px, py) in enumerate(points))
        style = ' stroke-dasharray="6 4"' if dashed else ""
        self.parts.append(
            f'<path d="{d}" fill="none" stroke="#334155" stroke-width="1.6"{style} marker-end="url(#arrow)"/>')
        if label:
            # Label on the longest segment.
            segs = list(zip(points, points[1:]))
            (x1, y1), (x2, y2) = max(segs, key=lambda s: abs(s[1][0] - s[0][0]) + abs(s[1][1] - s[0][1]))
            lx, ly = x1 + (x2 - x1) * label_at, y1 + (y2 - y1) * label_at + label_dy
            self.parts.append(
                f'<text x="{lx}" y="{ly}" font-size="13" text-anchor="middle" fill="#334155" '
                f'style="paint-order:stroke" stroke="#ffffff" stroke-width="4">{escape(label)}</text>')

    def text(self, x, y, s, size=13, anchor="start", color="#334155", italic=False):
        style = ' font-style="italic"' if italic else ""
        self.parts.append(
            f'<text x="{x}" y="{y}" font-size="{size}" text-anchor="{anchor}" fill="{color}"{style}>{escape(s)}</text>')

    def write(self, path):
        head = (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" '
            f'font-family="{FONT}">'
            '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" '
            'orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#334155"/></marker></defs>'
            f'<rect width="{W}" height="{H}" fill="#ffffff"/>'
            f'<text x="20" y="34" font-size="22" font-weight="bold" fill="#0f172a">{escape(self.title)}</text>')
        with open(path, "w") as f:
            f.write(head + "".join(self.parts) + "</svg>\n")


def mid(box, side):
    x, y, w, h = box
    return {"l": (x, y + h / 2), "r": (x + w, y + h / 2), "t": (x + w / 2, y), "b": (x + w / 2, y + h)}[side]


def draw(ha):
    s = Svg("Target HA design" if ha else "Deployed implementation (single AZ, no NAT gateway, as the instructor asked)")
    s.text(20, 58, "Region ap-southeast-1 (Singapore); CloudFront serves MY, TH and HK from nearby edge locations.", 14)

    # Users
    user = s.node(20, 300, 150, 90, ["Fans, organisers", "SG 80%; MY/TH/HK", "via CloudFront edges"])

    # Edge
    s.group(195, 90, 215, 330, "Edge (global)", EDGE)
    r53 = s.node(215, 125, 175, 50, ["Route 53"] if ha else ["Route 53", "(design only)"], dash=not ha)
    cf = s.node(215, 200, 175, 80, ["CloudFront", "+ WAF (common rules,", "IP rate limit)"])
    spa = s.node(215, 310, 175, 80, ["S3 site bucket", "private, OAC", "React SPA"])

    # Auth and API
    s.group(430, 90, 215, 330, "Auth and API front door", API)
    apigw = s.node(450, 125, 175, 95, ["API Gateway", "HTTP API, JWT", "authorizer, throttle", "100 rps / 200 burst"])
    cog = s.node(450, 290, 175, 80, ["Cognito", "user pool, group", "organisers"])

    # VPC
    vx, vw = 665, 590
    s.group(vx, 70, vw, 600, "VPC 10.20.0.0/16" + (" (2 AZs)" if ha else " (2 AZs; everything that runs is in AZ a)"), VPC)
    vpcl = s.node(vx + 20, 110, 150, 50, ["VPC link"])
    alb = s.node(vx + 200, 110, 370, 50, ["Internal ALB (nodes in AZ a + AZ b)"])

    az_w = 270
    ax_a, ax_b = vx + 20, vx + 20 + az_w + 10
    for ax, az in ((ax_a, "a"), (ax_b, "b")):
        s.group(ax, 180, az_w, 470, f"AZ {az}", "#ffffff")
        s.group(ax + 10, 215, az_w - 20, 130, "Public subnet", PUBLIC)
        s.group(ax + 10, 360, az_w - 20, 280, "Private subnet", PRIVATE)

    bw = az_w - 50  # box width inside a subnet
    if ha:
        egress = s.node(ax_a + 85, 245, 160, 80, ["NAT gateway", "(or interface", "endpoints)"])
        s.node(ax_b + 85, 245, 160, 80, ["NAT gateway", "(or interface", "endpoints)"])
        task_a = s.node(ax_a + 25, 395, bw, 70, ["ECS Fargate task", "ticketmastery-api"])
        task_b = s.node(ax_b + 25, 395, bw, 70, ["ECS Fargate task", "autoscaling 2-4+ tasks"])
        rds_a = s.node(ax_a + 25, 490, bw, 60, ["RDS PostgreSQL 16", "Multi-AZ primary"])
        rds_b = s.node(ax_b + 25, 490, bw, 60, ["RDS standby", "synchronous replica"])
        s.arrow([mid(rds_a, "r"), mid(rds_b, "l")], "sync", label_dy=-8)
        qm = s.node(ax_a + 25, 570, bw, 55, ["Lambda queue-manager", "(Python)"])
        tasks, src = [task_a, task_b], task_b
    else:
        task_a = s.node(ax_a + 25, 245, bw, 85, ["ECS Fargate: 1 task", "public IP for egress;", "inbound only from ALB"])
        s.text(ax_b + az_w / 2, 337, "empty (no NAT gateway)", 14, "middle", "#64748b", italic=True)
        rds_a = s.node(ax_a + 25, 395, bw, 70, ["RDS PostgreSQL 16", "single-AZ, 1-day PITR"])
        s.text(ax_b + az_w / 2, 600, "2nd ALB node and", 14, "middle", "#64748b", italic=True)
        s.text(ax_b + az_w / 2, 620, "DB subnet group member", 14, "middle", "#64748b", italic=True)
        qm = s.node(ax_a + 25, 495, bw, 55, ["Lambda queue-manager", "(Python)"])
        tasks, src, egress = [task_a], task_a, task_a

    # Waiting room, e-tickets, operations (regional, outside the VPC)
    rx = 1330
    s.group(rx, 70, 350, 220, "Waiting room (UC3)", ASYNC)
    sqsf = s.node(rx + 15, 105, 155, 60, ["SQS FIFO", "join-queue"])
    sched = s.node(rx + 180, 105, 155, 60, ["EventBridge", "Scheduler, 1 min"])
    ddb = s.node(rx + 15, 185, 320, 60, ["DynamoDB live-queue", "positions + admissions (15 min)"])
    s.text(rx + 175, 275, "both trigger queue-manager", 13, "middle", italic=True)

    s.group(rx, 305, 350, 250, "E-tickets (UC4 / UC2)", ASYNC)
    sns = s.node(rx + 15, 340, 155, 55, ["SNS", "order-events"])
    sqst = s.node(rx + 180, 340, 155, 55, ["SQS ticket-queue", "DLQ after 5 tries"])
    pdf = s.node(rx + 15, 410, 155, 60, ["S3 e-ticket PDFs", "private"])
    tfn = s.node(rx + 180, 410, 155, 60, ["Lambda ticket-fn", "outside VPC"])
    s.node(rx + 15, 485, 155, 55, ["Cognito lookup", "fan's email"], bold_first=False, dash=True)
    ses = s.node(rx + 180, 485, 155, 55, ["SES", "email + PDF"])
    s.arrow([mid(sns, "r"), mid(sqst, "l")], dashed=True)
    s.arrow([mid(sqst, "b"), mid(tfn, "t")], dashed=True)
    s.arrow([mid(tfn, "l"), mid(pdf, "r")], dashed=True)
    s.arrow([mid(tfn, "b"), mid(ses, "t")], dashed=True)

    s.group(rx, 570, 350, 165, "Operations", OPS)
    cw = s.node(rx + 15, 605, 155, 60, ["CloudWatch", "19 alarms, dashboard"])
    alerts = s.node(rx + 180, 605, 155, 60, ["SNS alerts", "-> team email"])
    bud = s.node(rx + 15, 675, 155, 50, ["AWS Budgets", "USD 80, 4 alerts"])
    s.arrow([mid(cw, "r"), mid(alerts, "l")])
    s.arrow([mid(bud, "r"), (rx + 257, 700), mid(alerts, "b")], dashed=True)

    # Regional services the task uses, under the VPC
    s.group(vx, 690, vw, 105, "Regional services", DESIGN)
    s.node(vx + 20, 725, 205, 55, ["QuickSight", "(design only)"], dash=True)
    ecr = s.node(vx + 245, 725, 150, 55, ["ECR", "API image"])
    sm = s.node(vx + 410, 725, 165, 55, ["Secrets Manager", "RDS-managed secret"])

    # Request path
    s.arrow([mid(user, "r"), (185, 345), (185, 150), mid(r53, "l")])
    s.arrow([mid(r53, "b"), mid(cf, "t")])
    s.arrow([mid(cf, "b"), mid(spa, "t")], "static", label_dy=4)
    s.arrow([mid(cf, "r"), (420, 240), (420, 172), mid(apigw, "l")], "/api/*")
    s.arrow([mid(apigw, "b"), mid(cog, "t")], "validate JWT", dashed=True, label_dy=4)
    s.arrow([mid(user, "b"), (95, 440), (537, 440), mid(cog, "b")], "sign in", dashed=True)
    s.arrow([mid(apigw, "r"), (655, 172), (655, 135), mid(vpcl, "l")])
    s.arrow([mid(vpcl, "r"), mid(alb, "l")])
    for t in tasks:
        s.arrow([(alb[0] + 20 + (t[0] - ax_a) // 2, 160), (alb[0] + 20 + (t[0] - ax_a) // 2, 172), (t[0] + 35, 172),
                 (t[0] + 35, t[1])])
    s.arrow([mid(task_a, "b"), mid(rds_a, "t")], "SQL", label_dy=4)

    # The API (any task) to the regional services: one vertical lane each between the VPC and the right column.
    sx, sy = src[0] + src[2], src[1] + src[3] / 2
    for dy, lane, target, label, dashed in (
        (-24, 1268, sqsf, "join", False),
        (-8, 1280, ddb, "admission check", False),
        (8, 1292, sns, "OrderConfirmed", False),
        (24, 1304, pdf, "pre-signed link", True),
    ):
        tx, ty = mid(target, "l")
        s.arrow([(sx, sy + dy), (lane, sy + dy), (lane, ty), (tx, ty)], dashed=dashed)
        s.text(tx - 4, ty - 5, label, 12, "end")
    qy = qm[1] + qm[3] / 2
    s.arrow([mid(qm, "r"), (1316, qy), (1316, 230), (rx + 15, 230)], dashed=True)
    s.text(mid(qm, "r")[0] + 8, qy - 6, "assign + admit", 12)

    # Egress to ECR and Secrets Manager (NAT in the HA design, the task's public IP in the implementation)
    ex = egress[0] + 30
    s.arrow([(ex, egress[1] + egress[3]), (ex, 352), (vx + 10, 352), (vx + 10, 680), (ecr[0] + 75, 680), mid(ecr, "t")],
            dashed=True)
    s.arrow([(ecr[0] + 75, 680), (sm[0] + 82, 680), mid(sm, "t")], dashed=True)
    s.text(vx + 20, 664, "image + DB secret " + ("via NAT" if ha else "via the task's public IP"), 12)

    # Notes, in the free space under the edge and API groups
    notes = (["HA design: tasks in the private subnets of both AZs,",
              "a NAT gateway per AZ, Multi-AZ RDS, autoscaling 2-4+.",
              "Same Terraform as the implementation; a block of",
              "tfvars switches between the two."]
             if ha else
             ["Implementation (instructor guidance): one task in AZ a's",
              "public subnet (public IP for egress only; inbound only",
              "from the ALB), no NAT gateway, single-AZ RDS.",
              "Same Terraform as the HA design; tfvars switch modes."])
    for i, n in enumerate(notes):
        s.text(20, 520 + i * 22, n, 15)
    s.text(20, 620, "Cost, whole stack (estimate): " + ("≈ USD 194/month" if ha else "≈ USD 72/month"), 15)
    s.text(20, 660, "Solid: request path. Dashed: async, egress", 14, italic=True)
    s.text(20, 680, "or optional. Dashed box: design only.", 14, italic=True)
    return s


draw(True).write("target-ha-architecture.svg")
draw(False).write("implementation-architecture.svg")
