const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('The Digital Fortress Aviator Server is officially LIVE!');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
