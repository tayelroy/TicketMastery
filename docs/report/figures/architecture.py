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

# The six per-feature ECS services (one image; ALB path rule each). reporting logs in to RDS as reporting_ro.
SERVICES = ("discovery", "account", "waiting-room", "checkout", "organiser", "reporting")


class Svg:
    def __init__(self, title):
        self.parts = []
        self.title = title

    def group(self, x, y, w, h, label, fill, dash=False, label_bottom=False):
        style = ' stroke-dasharray="8 5"' if dash else ""
        ly = y + h - 10 if label_bottom else y + 22
        self.parts.append(
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="{fill}" stroke="#64748b" '
            f'stroke-width="1.5"{style}/>'
            f'<text x="{x + 10}" y="{ly}" font-size="17" font-weight="bold" fill="#334155">{escape(label)}</text>')

    def services(self, x, y, title, sub):
        """ECS box with the six per-feature services as a 2 x 3 grid. Returns (box, {service: cell})."""
        w, h = 230, 136
        self.parts.append(
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="6" fill="#ffffff" stroke="#1e293b" stroke-width="1.4"/>'
            f'<text x="{x + w / 2}" y="{y + 20}" font-size="15" font-weight="bold" text-anchor="middle" '
            f'fill="#0f172a">{escape(title)}</text>'
            f'<text x="{x + w / 2}" y="{y + 37}" font-size="12" text-anchor="middle" fill="#0f172a">{escape(sub)}</text>')
        cells = {}
        for i, name in enumerate(SERVICES):
            cx, cy = x + 10 + (i % 2) * 110, y + 48 + (i // 2) * 28
            self.parts.append(
                f'<rect x="{cx}" y="{cy}" width="100" height="22" rx="4" fill="{API}" stroke="#1e293b" stroke-width="1"/>'
                f'<text x="{cx + 50}" y="{cy + 15.5}" font-size="12" text-anchor="middle" fill="#0f172a">{name}</text>')
            cells[name] = (cx, cy, 100, 22)
        return (x, y, w, h), cells

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

    def text(self, x, y, s, size=13, anchor="start", color="#334155", italic=False, halo=False):
        style = ' font-style="italic"' if italic else ""
        if halo:  # white outline so a label stays readable where a line crosses it
            style += ' style="paint-order:stroke" stroke="#ffffff" stroke-width="4"'
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
    alb = s.node(vx + 200, 110, 370, 50, ["Internal ALB: 6 path rules", "nodes in AZ a + AZ b"])

    az_w = 270
    ax_a, ax_b = vx + 20, vx + 20 + az_w + 10
    # HA: a small public subnet (NAT only), the services, RDS and the Lambda in the private one.
    # Implementation: the services in the public subnet, so the private subnet's label sits at its bottom
    # to keep it clear of the SQL arrows.
    pub_h, priv_y = (100, 325) if ha else (180, 405)
    for ax, az in ((ax_a, "a"), (ax_b, "b")):
        s.group(ax, 180, az_w, 470, f"AZ {az}", "#ffffff")
        s.group(ax + 10, 215, az_w - 20, pub_h, "Public subnet", PUBLIC)
        s.group(ax + 10, priv_y, az_w - 20, 640 - priv_y, "Private subnet", PRIVATE, label_bottom=not ha)

    bw = az_w - 40  # box width inside a subnet
    if ha:
        egress = s.node(ax_a + 85, 240, 160, 60, ["NAT gateway", "(or endpoints)"])
        s.node(ax_b + 85, 240, 160, 60, ["NAT gateway", "(or endpoints)"])
        task_a, cells = s.services(ax_a + 20, 355, "ECS Fargate, 6 services", "each ≥ 2 tasks, one per AZ")
        task_b, _ = s.services(ax_b + 20, 355, "ECS Fargate, 6 services", "own autoscaling per service")
        rds_a = s.node(ax_a + 20, 525, bw, 50, ["RDS PostgreSQL 16", "Multi-AZ primary"])
        rds_b = s.node(ax_b + 20, 525, bw, 50, ["RDS standby", "synchronous replica"])
        s.arrow([mid(rds_a, "r"), mid(rds_b, "l")], "sync", label_dy=-8)
        qm = s.node(ax_a + 20, 585, bw, 48, ["Lambda queue-manager", "(Python)"])
        tasks, src = [task_a, task_b], task_b
    else:
        task_a, cells = s.services(ax_a + 20, 240, "6 services × 1 task", "public IP, inbound only from ALB")
        s.text(ax_b + az_w / 2, 365, "empty (no NAT gateway)", 14, "middle", "#64748b", italic=True)
        rds_a = s.node(ax_a + 20, 430, bw, 60, ["RDS PostgreSQL 16", "single-AZ, 1-day PITR"])
        s.text(ax_b + az_w / 2, 455, "2nd ALB node and", 14, "middle", "#64748b", italic=True)
        s.text(ax_b + az_w / 2, 475, "DB subnet group member", 14, "middle", "#64748b", italic=True)
        qm = s.node(ax_a + 20, 515, bw, 55, ["Lambda queue-manager", "(Python)"])
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
    cw = s.node(rx + 15, 605, 155, 60, ["CloudWatch", "30 alarms, dashboard"])
    alerts = s.node(rx + 180, 605, 155, 60, ["SNS alerts", "-> team email"])
    bud = s.node(rx + 15, 675, 155, 50, ["AWS Budgets", "USD 80, 4 alerts"])
    s.arrow([mid(cw, "r"), mid(alerts, "l")])
    s.arrow([mid(bud, "r"), (rx + 257, 700), mid(alerts, "b")], dashed=True)

    # Regional services the tasks use, under the VPC
    s.group(vx, 690, vw, 105, "Regional services", DESIGN)
    ecr = s.node(vx + 20, 725, 200, 55, ["ECR", "one API image, 6 services"])
    sm = s.node(vx + 240, 725, 330, 55, ["Secrets Manager", "RDS master secret + reporting-ro secret"])

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
        # Down the gap at the AZ's right edge, then into the services box (keeps clear of the subnet labels).
        lane = t[0] + t[2] + 15
        s.arrow([(alb[0] + 20 + (t[0] - ax_a) // 2, 160), (alb[0] + 20 + (t[0] - ax_a) // 2, 172), (lane, 172),
                 (lane, t[1] + 18), (t[0] + t[2], t[1] + 18)])
    # Five services log in to RDS as the master user; reporting as reporting_ro (SELECT on the report views only).
    bottom = task_a[1] + task_a[3]
    mx = cells["discovery"][0] + 50
    rep = cells["reporting"]
    rpx = rep[0] + 50
    s.arrow([(mx, bottom), (mx, rds_a[1])])
    s.arrow([(rpx, rep[1] + rep[3]), (rpx, rds_a[1])])
    ly = (bottom + rds_a[1]) / 2 + 5
    s.text(mx - 5, ly, "master", 12, "end")
    s.text(rpx - 5, ly, "reporting_ro", 12, "end")

    # The API (any task) to the regional services: one vertical lane each between the VPC and the right column.
    sx, sy = src[0] + src[2], src[1] + src[3] / 2
    lanes = (
        (-24, 1268, sqsf, "join", False),
        (-8, 1280, ddb, "admission check", False),
        (8, 1292, sns, "OrderConfirmed", False),
        (24, 1304, pdf, "pre-signed link", True),
    )
    for dy, lane, target, _, dashed in lanes:
        tx, ty = mid(target, "l")
        s.arrow([(sx, sy + dy), (lane, sy + dy), (lane, ty), (tx, ty)], dashed=dashed)
    qy = qm[1] + qm[3] / 2
    s.arrow([mid(qm, "r"), (1316, qy), (1316, 230), (rx + 15, 230)], dashed=True)
    # Labels last, with a halo, so the other lanes don't run through them.
    for _, _, target, label, _ in lanes:
        tx, ty = mid(target, "l")
        s.text(tx - 4, ty - 5, label, 12, "end", halo=True)
    s.text(mid(qm, "r")[0] + 8, qy - 6, "assign + admit", 12, halo=True)

    # Egress to ECR and Secrets Manager (NAT in the HA design, the task's public IP in the implementation)
    ex = egress[0] + 30
    ey = egress[1] + egress[3] + 7
    s.arrow([(ex, egress[1] + egress[3]), (ex, ey), (vx + 10, ey), (vx + 10, 680), (ecr[0] + 100, 680), mid(ecr, "t")],
            dashed=True)
    s.arrow([(ecr[0] + 100, 680), (sm[0] + 165, 680), mid(sm, "t")], dashed=True)
    s.text(vx + 20, 664, "image + DB secrets " + ("via NAT" if ha else "via the tasks' public IPs"), 12)

    # Notes, in the free space under the edge and API groups
    notes = (["HA design: 6 per-feature ECS services, each with at",
              "least 2 tasks across the private subnets of both AZs,",
              "a NAT gateway per AZ, Multi-AZ RDS. Same Terraform",
              "as the implementation; tfvars switch between the two."]
             if ha else
             ["Implementation (instructor guidance): 6 per-feature",
              "ECS services, 1 task each, in AZ a's public subnet",
              "(public IP for egress only; inbound only from the ALB),",
              "no NAT gateway, single-AZ RDS. HA is design only."])
    notes.append("reporting: DB login reporting_ro, read-only, views only.")
    for i, n in enumerate(notes):
        s.text(20, 500 + i * 22, n, 15)
    s.text(20, 628, "Cost, whole stack (estimate): " + ("≈ USD 311/month" if ha else "≈ USD 150/month"), 15)
    s.text(20, 652, "QuickSight removed: not available on the AWS Free plan.", 14)
    s.text(20, 690, "Solid: request path. Dashed: async, egress", 14, italic=True)
    s.text(20, 710, "or optional. Dashed box: design only.", 14, italic=True)
    return s


draw(True).write("target-ha-architecture.svg")
draw(False).write("implementation-architecture.svg")
