import app from "./app.js";
import { connectMongo } from "./db/mongoose.js";
import { config } from "./config.js";

await connectMongo();

app.listen(config.port, () => {
  console.log(`BONDOO API listening on :${config.port}`);
});
