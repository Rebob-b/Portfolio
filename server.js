const { createReadStream } = require("node:fs");
const { createServer } = require("node:http");
const path = require("node:path");
const nodemailer = require("nodemailer");

const root = __dirname;
const port = Number(process.env.PORT || 3000);

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
    ["/js/contact.js", "js/contact.js"]
]);

const mimeTypes = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8"
};

const recentSubmissions = new Map();
const submissionWindowMs = 60_000;
const maxSubmissionsPerWindow = 5;

function sendJson(response, status, payload) {
    response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
    });
    response.end(JSON.stringify(payload));
}

function setSecurityHeaders(response) {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    response.setHeader("X-Frame-Options", "DENY");
}

async function readJson(request) {
    let raw = "";

    for await (const chunk of request) {
        raw += chunk;
        if (raw.length > 16_000) throw new Error("Het bericht is te groot.");
    }

    try {
        return JSON.parse(raw);
    } catch {
        throw new Error("Het formulier bevat ongeldige gegevens.");
    }
}

function isRateLimited(address) {
    const now = Date.now();
    const timestamps = (recentSubmissions.get(address) || [])
        .filter((timestamp) => now - timestamp < submissionWindowMs);

    if (timestamps.length >= maxSubmissionsPerWindow) {
        recentSubmissions.set(address, timestamps);
        return true;
    }

    timestamps.push(now);
    recentSubmissions.set(address, timestamps);
    return false;
}

async function handleContact(request, response) {
    if (!request.headers["content-type"]?.includes("application/json")) {
        sendJson(response, 415, { error: "Ongeldig formulierformaat." });
        return;
    }

    let fields;
    try {
        fields = await readJson(request);
    } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
    }

    // Stil antwoorden op bots die het verborgen veld invullen.
    if (typeof fields.website === "string" && fields.website.trim()) {
        sendJson(response, 200, { message: "Bedankt voor je bericht. Het is verstuurd." });
        return;
    }

    const name = typeof fields.naam === "string" ? fields.naam.trim() : "";
    const email = typeof fields.email === "string" ? fields.email.trim() : "";
    const message = typeof fields.bericht === "string" ? fields.bericht.trim() : "";

    if (!name || name.length > 80 || !email || email.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !message || message.length > 2000) {
        sendJson(response, 400, { error: "Controleer je naam, e-mailadres en bericht." });
        return;
    }

    if (isRateLimited(request.socket.remoteAddress || "unknown")) {
        sendJson(response, 429, { error: "Je hebt net meerdere berichten verstuurd. Probeer het straks opnieuw." });
        return;
    }

    const requiredSettings = ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "MAIL_FROM", "MAIL_TO"];
    if (requiredSettings.some((key) => !process.env[key])) {
        sendJson(response, 503, { error: "E-mail is nog niet ingesteld op de server." });
        return;
    }

    const smtpPort = Number(process.env.SMTP_PORT || 587);
    const secure = process.env.SMTP_SECURE === "true";
    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: smtpPort,
        secure,
        requireTLS: !secure,
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
        }
    });

    try {
        await transporter.sendMail({
            from: process.env.MAIL_FROM,
            to: process.env.MAIL_TO,
            replyTo: { name, address: email },
            subject: `Portfolio-contactbericht van ${name}`,
            text: `Naam: ${name}\nE-mail: ${email}\n\nBericht:\n${message}`
        });
    } catch (error) {
        console.error("Contactmail verzenden is mislukt:", error.message);
        sendJson(response, 502, { error: "De e-mail kon niet worden verstuurd. Controleer de SMTP-instellingen." });
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

    const relativePath = publicFiles.get(pathname);
    if (request.method !== "GET" || !relativePath) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Niet gevonden");
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
            response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            response.end("Bestand niet gevonden");
        } else {
            response.destroy();
        }
    });
});

server.listen(port, "0.0.0.0", () => {
    console.log(`Portfolio beschikbaar op http://localhost:${port}`);
});
