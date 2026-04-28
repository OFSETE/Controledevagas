import re

def refactor():
    with open('server.js', 'r', encoding='utf8') as f:
        code = f.content = f.read()

    # Change function definitions to async
    funcs_to_async = [
        'getLimiteSentados', 'getBancosTraseiros', 'calcularAssentosDoDia',
        'calcularAssentosIdaVolta', 'calcularAssentosTrechoComPonteiro',
        'calcularBancosTraseirosComExclusao', 'calcularBancosTraseiros',
        'avancarPonteiroAssentos', 'avancarPonteiroBancos',
        'gerarRelatorioDoDia', 'limparRespostasDia'
    ]
    
    for fn in funcs_to_async:
        code = re.sub(fr'function {fn}\(', f'async function {fn}(', code)

    # Change function calls to await
    for fn in funcs_to_async:
        code = re.sub(fr'(?<!async function ){fn}\(', f'await {fn}(', code)

    # Make Express routes async
    code = re.sub(r'app\.(get|post|put|delete)\(([^,]+),\s*(limiteGeral|limiteEscrita),\s*\(req, res\) => {', r'app.\1(\2, \3, async (req, res) => {', code)
    code = re.sub(r'app\.(get|post|put|delete)\(([^,]+),\s*\(req, res\) => {', r'app.\1(\2, async (req, res) => {', code)

    # db.prepare('SELECT ...').get(args) -> (await db.execute({ sql: 'SELECT ...', args: [args] })).rows[0]
    code = re.sub(
        r'db\.prepare\((.*?)\)\.get\((.*?)\)',
        lambda m: f"(await db.execute({{ sql: {m.group(1)}, args: [{m.group(2)}] }})).rows[0]" if m.group(2).strip() else f"(await db.execute({m.group(1)})).rows[0]",
        code
    )

    # db.prepare('SELECT ...').all(args) -> (await db.execute({ sql: 'SELECT ...', args: [args] })).rows
    code = re.sub(
        r'db\.prepare\((.*?)\)\.all\((.*?)\)',
        lambda m: f"(await db.execute({{ sql: {m.group(1)}, args: [{m.group(2)}] }})).rows" if m.group(2).strip() else f"(await db.execute({m.group(1)})).rows",
        code
    )

    # db.prepare('INSERT...').run(args) -> await db.execute({ sql: 'INSERT...', args: [args] })
    code = re.sub(
        r'db\.prepare\((.*?)\)\.run\((.*?)\)',
        lambda m: f"await db.execute({{ sql: {m.group(1)}, args: [{m.group(2)}] }})" if m.group(2).strip() else f"await db.execute({m.group(1)})",
        code
    )

    with open('server_refactored.js', 'w', encoding='utf8') as f:
        f.write(code)

if __name__ == '__main__':
    refactor()
