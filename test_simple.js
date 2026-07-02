const { app } = require('electron')

async function main() {
    await app.whenReady()
    console.log('app ready:', typeof app, app.getPath('userData'))
    app.quit()
}

main().catch(e => console.error('error:', e.message))