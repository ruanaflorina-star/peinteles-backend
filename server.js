import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import Tesseract from "tesseract.js";
import OpenAI from "openai";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

// ✅ AICI SE DEFINEȘTE app (OBLIGATORIU)
const app = express();

// ✅ DUPĂ ce app există
const upload = multer({ dest: "uploads/" });

app.use(cors({
origin: "*",
methods: ["GET", "POST", "OPTIONS"],
allowedHeaders: ["Content-Type"]
}));

app.options("*", cors());
app.use(express.json());

const openai = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});

/* =========================
HEALTH CHECK
========================= */
app.get("/", (req, res) => {
res.json({
status: "ok",
message: "Peinteles backend running",
});
});

/* =========================
OCR + AI ENDPOINT
========================= */
app.post("/api/interpret", upload.single("file"), async (req, res) => {
try {
let extractedText = "";

/* ====== TEXT DIRECT ====== */
if (req.body.text && req.body.text.trim() !== "") {
extractedText = req.body.text;
}

/* ====== FILE ====== */
if (req.file) {
const filePath = req.file.path;
const mime = req.file.mimetype;

// PDF
if (mime === "application/pdf") {
const dataBuffer = fs.readFileSync(filePath);
const pdfData = await pdfParse(dataBuffer);

if (pdfData.text.trim().length > 50) {
extractedText = pdfData.text;
} else {
// OCR PDF scanat
const ocr = await Tesseract.recognize(filePath, "eng+ron");
extractedText = ocr.data.text;
}
}

// IMAGINE
if (mime.startsWith("image/")) {
const ocr = await Tesseract.recognize(filePath, "eng+ron");
extractedText = ocr.data.text;
}

fs.unlinkSync(filePath);
}

if (!extractedText || extractedText.trim().length < 20) {
return res.status(400).json({
error: "Nu s-a putut extrage text relevant din document.",
});
}

/* ====== AI ====== */
const completion = await openai.chat.completions.create({
model: "gpt-4o-mini",
messages: [
{
role: "system",
content:
"Ești un asistent care explică documente oficiale pe înțelesul tuturor, clar și structurat.",
},
{
role: "user",
content: extractedText,
},
],
});

res.json({
extractedText,
interpretation: completion.choices[0].message.content,
});
} catch (err) {
console.error(err);
res.status(500).json({
error: "Eroare server OCR / AI",
});
}
});

/* ========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
console.log("Server pornit pe port", PORT);
});
