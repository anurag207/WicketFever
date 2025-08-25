import express from "express";
import dotenv from "dotenv";


const app = express();
const port = process.env.PORT || 5000;

app.get("/", (req, res) => {
    res.send({
        code: 200,
        status: "success",
        message: "welcome to wicketfever"
    })
})

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});

