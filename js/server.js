const { createReadStream } = require("node:fs");
const { createServer } = require("node:http");
const path = require("node:path");
const nodemailer = require("nodemailer");

const root = __dirname;
const port = Number(process.env.PORT) || 3000;
const maxBodySize = 10 * 1024;
const rateWindow = 15 * 60 * 1000;
const rateLimit = 5;
const recentRequests = new Map();
const cleanupRateLimit = setInterval(() => {
    const cutoff = Date.now() - rateWindow;
    for (const [address, entry] of recentRequests) {
        if (entry.startedAt < cutoff) {
            recentRequests.delete(address);
        }
    }
}, rateWindow);
cleanupRateLimit.unref();

const publicFiles = new Map([
    ["/", "index.html"],
    ["/index.html", "index.html"],
    ["/about.html", "about.html"],
    ["/skills.html", "skills.html"],
    ["/contact.html", "contact.html"],
    ["/css/main.css", "css/main.css"],
    ["/css/home.css", "css/home.css"],
    ["/css/responsive.css", "css/responsive.css"],
    ["/css/animations.css", "css/animations.css"],
    ["/CSS/main.css", "css/main.css"],
    ["/CSS/home.css", "css/home.css"],
    ["/CSS/responsive.css", "css/responsive.css"],
    ["/CSS/animations.css", "css/animations.css"],
    ["/js/contact.js", "js/contact.js"]
]);

const mimeTypes = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
    ".txt": "text/plain; charset=utf-8"
};

const smtpPort = Number(process.env.SMTP_PORT) || 587;
const mailer = process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS
    ? nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: smtpPort,
        secure: process.env.SMTP_SECURE === "true" || smtpPort === 465,
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
        },
        connectionTimeout: 10000,
        socketTimeout: 15000
    })
    : null;

function setSecurityHeaders(response) {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

function sendJson(response, status, data) {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(data));
}

function getSiteUrl() {
    if (!process.env.SITE_URL) {
        return null;
    }

    const url = new URL(process.env.SITE_URL);
    if (!["http:", "https:"].includes(url.protocol) || url.search || url.hash) {
        throw new Error("SITE_URL must be a public HTTP(S) URL without a query or hash.");
    }

    return `${url.origin}${url.pathname}`.replace(/\/$/, "");
}

function sitemapXml(baseUrl) {
    const pages = ["/", "/about.html", "/skills.html", "/contact.html"];
    const urls = pages.map((page) => `    <url><loc>${baseUrl}${page}</loc></url>`).join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

function checkRateLimit(request, response) {
    const now = Date.now();
    const address = request.socket.remoteAddress || "unknown";
    const current = recentRequests.get(address);

    if (!current || now - current.startedAt >= rateWindow) {
        recentRequests.set(address, { startedAt: now, count: 1 });
        return true;
    }

    if (current.count >= rateLimit) {
        response.setHeader("Retry-After", String(Math.ceil((rateWindow - (now - current.startedAt)) / 1000)));
        sendJson(response, 429, { error: "Er zijn te veel berichten verstuurd. Probeer het later opnieuw." });
        return false;
    }

    current.count += 1;
    return true;
}

function checkOrigin(request, response) {
    const origin = request.headers.origin;
    if (!origin) {
        return true;
    }

    let originUrl;
    try {
        originUrl = new URL(origin);
    } catch {
        sendJson(response, 403, { error: "Ongeldige aanvraagbron." });
        return false;
    }

    const host = request.headers.host;
    const forwardedProto = request.headers["x-forwarded-proto"];
    const protocol = forwardedProto === "https" ? "https:" : "http:";
    if (originUrl.origin !== `${protocol}//${host}`) {
        sendJson(response, 403, { error: "Aanvraag geweigerd." });
        return false;
    }

    return true;
}

function readBody(request) {
    return new Promise((resolve, reject) => {
        const contentLength = Number(request.headers["content-length"]);
        if (Number.isFinite(contentLength) && contentLength > maxBodySize) {
            reject(Object.assign(new Error("Request body is too large."), { status: 413 }));
            request.resume();
            return;
        }

        const chunks = [];
        let length = 0;
        let rejected = false;

        request.on("data", (chunk) => {
            length += chunk.length;
            if (length > maxBodySize) {
                rejected = true;
                request.resume();
                reject(Object.assign(new Error("Request body is too large."), { status: 413 }));
                return;
            }
            chunks.push(chunk);
        });

        request.on("end", () => {
            if (!rejected) {
                resolve(Buffer.concat(chunks).toString("utf8"));
            }
        });

        request.on("error", (error) => {
            if (!rejected) {
                reject(error);
            }
        });
    });
}

function parseForm(request, body) {
    const contentType = request.headers["content-type"] || "";
    if (contentType.includes("application/json")) {
        return JSON.parse(body);
    }
    if (contentType.includes("application/x-www-form-urlencoded")) {
        return Object.fromEntries(new URLSearchParams(body));
    }
    throw Object.assign(new Error("Unsupported content type."), { status: 415 });
}

async function handleContact(request, response) {
    if (!checkOrigin(request, response) || !checkRateLimit(request, response)) {
        return;
    }

    let form;
    try {
        form = parseForm(request, await readBody(request));
    } catch (error) {
        sendJson(response, error.status || 400, {
            error: error.status === 413
                ? "Het bericht is te groot. Beperk het tot 2000 tekens."
                : "Het formulier kon niet worden gelezen. Controleer de invoer en probeer opnieuw."
        });
        return;
    }

    if (typeof form !== "object" || form === null || Array.isArray(form)) {
        sendJson(response, 400, { error: "Ongeldige formuliergegevens." });
        return;
    }

    if (typeof form.website === "string" && form.website.trim()) {
        sendJson(response, 200, { message: "Bedankt voor je bericht." });
        return;
    }

    const name = typeof form.naam === "string" ? form.naam.trim() : "";
    const email = typeof form.email === "string" ? form.email.trim() : "";
    const message = typeof form.bericht === "string" ? form.bericht.trim() : "";
    const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

    if (!name || name.length > 80 || /[\u0000-\u001f]/.test(name)
        || email.length > 254 || !validEmail
        || !message || message.length > 2000) {
        sendJson(response, 400, { error: "Vul een geldige naam, e-mail en bericht in." });
        return;
    }

    if (!mailer || !process.env.MAIL_TO || !process.env.MAIL_FROM) {
        sendJson(response, 503, { error: "Het contactformulier is nog niet ingesteld. Mail rechtstreeks naar kannolivier@gmail.com." });
        return;
    }

    try {
        await mailer.sendMail({
            from: process.env.MAIL_FROM,
            to: process.env.MAIL_TO,
            replyTo: email,
            subject: `Portfolio contactbericht van ${name}`,
            text: `Naam: ${name}\nE-mail: ${email}\n\nBericht:\n${message}`
        });
    } catch (error) {
        console.error("Contact email failed:", error.message);
        sendJson(response, 502, { error: "Het bericht kon niet worden afgeleverd. Probeer het later opnieuw." });
        return;
    }

    sendJson(response, 200, { message: "Bedankt voor je bericht. Het is verstuurd." });
}

const server = createServer(async (request, response) => {
    setSecurityHeaders(response);

    let pathname;
    try {
        pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    } catch {
        sendJson(response, 400, { error: "Ongeldige URL." });
        return;
    }

    if (request.method === "GET" && pathname === "/healthz") {
        sendJson(response, 200, { status: "ok" });
        return;
    }

    if (request.method === "POST" && pathname === "/api/contact") {
        await handleContact(request, response);
        return;
    }

    if (request.method === "GET" && pathname === "/sitemap.xml") {
        try {
            const baseUrl = getSiteUrl();
            if (!baseUrl) {
                sendJson(response, 503, { error: "Stel SITE_URL in om een sitemap voor je publieke domein te maken." });
                return;
            }
            response.writeHead(200, {
                "Content-Type": "application/xml; charset=utf-8",
                "Cache-Control": "public, max-age=3600"
            });
            response.end(sitemapXml(baseUrl));
        } catch (error) {
            sendJson(response, 500, { error: error.message });
        }
        return;
    }

    if (request.method === "GET" && pathname === "/robots.txt") {
        let siteUrl;
        try {
            siteUrl = getSiteUrl();
        } catch (error) {
            sendJson(response, 500, { error: error.message });
            return;
        }
        const sitemapLine = siteUrl ? `Sitemap: ${siteUrl}/sitemap.xml\n` : "";
        response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        response.end(`User-agent: *\nAllow: /\n${sitemapLine}`);
        return;
    }

    const relativePath = publicFiles.get(pathname);
    if (request.method !== "GET" || !relativePath) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
    }

    const filePath = path.join(root, relativePath);
    const stream = createReadStream(filePath);
    stream.on("open", () => {
        response.writeHead(200, {
            "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
            "Cache-Control": filePath.endsWith(".html") ? "no-cache" : "public, max-age=3600"
        });
        stream.pipe(response);
    });
    stream.on("error", () => {
        if (!response.headersSent) {
            sendJson(response, 404, { error: "Bestand niet gevonden." });
        } else {
            response.destroy();
        }
    });
});

server.listen(port, "0.0.0.0", () => {
    console.log(`Portfolio available at http://localhost:${port}`);
});
