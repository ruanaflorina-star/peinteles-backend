import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

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