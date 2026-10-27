import express from "express";

const app = express();

app.get("/", (_request, response) => {
  response.json({ service: "b2b-portal-api" });
});

app.listen(3000, "127.0.0.1");
