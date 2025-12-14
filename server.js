import express from "express";
import cors from "cors";

const app = express();

/* middleware – PRIMELE */
app.use(cors());
app.use(express.json());

/* ruta de test */
app.get("/", (req, res) => {
res.json({
status: "OK",
message: "Peinteles backend is running 🚀"
});
});

/* ruta ta POST */
app.post("/interpretare", (req, res) => {
const { document } = req.body;

res.json({
status: "ok",
mesaj: "Backend funcționează corect",
primit: document
});
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
console.log("Server pornit pe port " + PORT);
});
