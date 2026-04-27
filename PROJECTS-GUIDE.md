# FCAdv – Guia de Gerenciamento de Projetos

## Acessando a página de Projetos

Abra o sistema em `http://localhost:3005` → clique em **⚙ Projetos** no canto superior direito.

---

## Editando as instruções de um projeto

1. Clique no nome do projeto na barra lateral esquerda (ex: **Embargos à Execução / Impugnação**)
2. Edite o campo **Instruções do Sistema** — este é exatamente o texto que o Claude recebe como instrução ao gerar documentos desse tipo de tarefa
3. Pressione **Ctrl+S** ou clique em **Salvar**

> **Dica:** Cole aqui o texto completo das instruções do seu Projeto no Claude.ai. O que o Claude segue lá, ele seguirá aqui também.

---

## Adicionando arquivos de referência (exemplos de estilo)

1. Selecione um projeto
2. Na seção **Arquivos de Referência**, clique em **+ Adicionar arquivos**
3. Selecione um ou mais arquivos `.docx`, `.pdf` ou `.txt` — peças reais do escritório funcionam melhor
4. Os arquivos ficam salvos e aparecem como cartões — clique em **👁 Ver** para visualizar o texto extraído
5. Clique em **🗑 Remover** para excluir um arquivo

Quando o Claude gerar uma petição para aquele tipo de tarefa, esses arquivos são incluídos automaticamente como contexto de estilo.

---

## Como funciona a correspondência automática

Cada projeto possui **Palavras-chave**. Quando uma tarefa chega do Projuris, o sistema compara o tipo da tarefa com todas as palavras-chave e escolhe o projeto mais específico.

| Tipo de tarefa no Projuris | Projeto utilizado |
|---|---|
| "Agravo de Instrumento" | Agravo de Instrumento |
| "Impugnação aos Embargos" | Embargos à Execução / Impugnação |
| "Embargos de Declaração" | Embargos de Declaração |
| "Investigação Patrimonial" | Investigação Patrimonial / IDPJ |
| *(tipo não reconhecido)* | Petição (padrão) |

Para adicionar um novo tipo de tarefa: abra o projeto → adicione a palavra-chave no campo **Palavras-chave** → Salvar.

---

## Criando um novo projeto

1. Clique em **+ Novo**
2. Digite o nome — o ID é gerado automaticamente
3. Preencha as palavras-chave e as instruções
4. Faça upload dos arquivos de referência
5. Salvar

---

## Excluindo um projeto

1. Selecione o projeto
2. Clique em **Excluir Projeto** (canto inferior esquerdo)
3. Confirme a exclusão

> **Atenção:** se nenhum outro projeto tiver palavras-chave que correspondam ao tipo da tarefa excluída, o sistema usará o projeto **Petição (padrão)** como fallback.

---

## O que NÃO é necessário fazer

- Nenhuma alteração de código — tudo é gerenciado pelo navegador
- O arquivo `config/projects.json` é atualizado automaticamente ao salvar
- Não é necessário reiniciar o servidor após editar projetos
- Não é necessário acessar o Claude.ai para ajustar instruções — use diretamente esta página

---

## Projetos disponíveis (17 padrão)

| Projeto | Tipos de tarefa correspondentes |
|---|---|
| Agravo de Instrumento | agravo de instrumento, agravo |
| Agravo Interno / Regimental | agravo interno, regimental |
| Análise Processual | análise, analise |
| Apelação Cível | apelação, apelacao |
| Contrarrazões de Apelação | contrarrazões, contrarrazoes, contrar |
| Convalidação de Intimação | convalid, intimaç |
| Embargos de Declaração | embargos de declaração |
| Embargos à Execução / Impugnação | embargos à execução, impugnação |
| Embargos de Terceiro | embargos de terceiro |
| Investigação Patrimonial / IDPJ | investigação, idpj |
| Memoriais / Alegações Finais | memorial, alegações finais |
| Penhora / SISBAJUD | penhora, sisbajud |
| Petição Estratégica (Regulatório) | sisflora, ambiental, regulat |
| Polo Passivo + Arresto Cautelar | polo passivo, arresto cautelar |
| RENAJUD / Penhora de Veículos | renajud |
| Revisão de Processo | revisão de processo |
| Petição (padrão) | *(fallback para tipos não reconhecidos)* |
