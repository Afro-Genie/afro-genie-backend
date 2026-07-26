$env:NODE_ENV = "development"
$env:PORT = "3001"
$env:ENABLE_WORKERS = "false"
Set-Location "C:\Users\tidar\Documents\Web Dev Projects\afro-genie\afro-genie-backend"
npx tsx src/index.ts
