const fs = require('fs');

let code = fs.readFileSync('server.js', 'utf8');

const funcs_to_async = [
    'getLimiteSentados', 'getBancosTraseiros', 'calcularAssentosDoDia',
    'calcularAssentosIdaVolta', 'calcularAssentosTrechoComPonteiro',
    'calcularBancosTraseirosComExclusao', 'calcularBancosTraseiros',
    'avancarPonteiroAssentos', 'avancarPonteiroBancos',
    'gerarRelatorioDoDia', 'limparRespostasDia'
];

funcs_to_async.forEach(fn => {
    // Change function declarations to async
    const regexFunc = new RegExp(`function ${fn}\\(`, 'g');
    code = code.replace(regexFunc, `async function ${fn}(`);

    // Change function calls to await (only if not preceded by async function)
    const regexCall = new RegExp(`(?<!async function )${fn}\\(`, 'g');
    code = code.replace(regexCall, `await ${fn}(`);
});

// Make Express routes async
code = code.replace(/app\.(get|post|put|delete)\(([^,]+),\s*(limiteGeral|limiteEscrita),\s*\(req, res\) => {/g, 'app.$1($2, $3, async (req, res) => {');
code = code.replace(/app\.(get|post|put|delete)\(([^,]+),\s*\(req, res\) => {/g, 'app.$1($2, async (req, res) => {');

// Replace db.prepare(SQL).get(args)
code = code.replace(/db\.prepare\((.*?)\)\.get\((.*?)\)/g, (match, sql, args) => {
    if (args.trim()) {
        return `(await db.execute({ sql: ${sql}, args: [${args}] })).rows[0]`;
    }
    return `(await db.execute(${sql})).rows[0]`;
});

// Replace db.prepare(SQL).all(args)
code = code.replace(/db\.prepare\((.*?)\)\.all\((.*?)\)/g, (match, sql, args) => {
    if (args.trim()) {
        return `(await db.execute({ sql: ${sql}, args: [${args}] })).rows`;
    }
    return `(await db.execute(${sql})).rows`;
});

// Replace db.prepare(SQL).run(args)
code = code.replace(/db\.prepare\((.*?)\)\.run\((.*?)\)/g, (match, sql, args) => {
    if (args.trim()) {
        return `await db.execute({ sql: ${sql}, args: [${args}] })`;
    }
    return `await db.execute(${sql})`;
});

// Fix cron jobs to have async functions if they use await inside
code = code.replace(/cron\.schedule\('(.*?)', \(\) => {/g, "cron.schedule('$1', async () => {");

fs.writeFileSync('server_refactored.js', code, 'utf8');
console.log('Refactoring complete!');
