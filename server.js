import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import Tesseract from "tesseract.js";
import OpenAI from "openai";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse"); // <-- CORECT pt Node 22 + ESModules

/* =======================
INIT
======================= */
const app = express();
const upload = multer({ dest: "uploads/" });

app.use(cors({
origin: "*",
methods: ["GET", "POST"],
allowedHeaders: ["Content-Type"]
}));

app.use(express.json());

/* =======================
OPENAI
======================= */
const openai = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});

/* =======================
HEALTH CHECK
======================= */
app.get("/", (req, res) => {
res.json({ status: "ok", message: "Peinteles backend running" });
});

/* =======================
OCR + AI
======================= */
app.post("/api/interpret", upload.single("file"), async (req, res) => {
try {
let extractedText = "";

/* TEXT DIRECT */
if (req.body.text && req.body.text.trim() !== "") {
extractedText = req.body.text;
}

/* FILE */
if (req.file) {
const filePath = req.file.path;
const mime = req.file.mimetype;

// PDF
if (mime === "application/pdf") {
const buffer = fs.readFileSync(filePath);
const pdfData = await pdfParse(buffer);

if (pdfData.text && pdfData.text.trim().length > 50) {
extractedText = pdfData.text;
} else {
const ocr = await Tesseract.recognize(filePath, "eng+ron");
extractedText = ocr.data.text;
}
}

// IMAGE
if (mime.startsWith("image/")) {
const ocr = await Tesseract.recognize(filePath, "eng+ron");
extractedText = ocr.data.text;
}

fs.unlinkSync(filePath);
}

if (!extractedText || extractedText.trim() === "") {
return res.status(400).json({ error: "Nu am putut extrage text." });
}

/* AI */
const completion = await openai.chat.completions.create({
model: "gpt-4o-mini",
messages: [
{
role: "system",
content: "Interpretează clar și structurat documentul."
},
{
role: "user",
content: extractedText
}
]
});

res.json({
interpretation: completion.choices[0].message.content
});

} catch (err) {
console.error(err);
res.status(500).json({ error: "Eroare server OCR / AI" });
}
});

/* =======================
START
======================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
console.log("Server pornit pe port", PORT);
});
