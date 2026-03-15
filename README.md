# ShelfVision MVP (Local/Híbrido)

MVP de análise de prateleira com IA rodando no navegador.

## Recursos implementados

- Upload por clique e drag-and-drop
- Preview da imagem
- Detecção de objetos com COCO-SSD (TensorFlow.js)
- OCR global e regional (Tesseract.js) para reconhecer marcas escritas na embalagem
- Heurísticas de segmentação e assinatura de cor para reforçar marcas difíceis de ler
- Bounding boxes com confiança
- Contagem de produtos
- Share de prateleira por item
- Análise de layout (esquerda/centro/direita)
- Compatibilidade semântica texto ↔ produtos detectados com Universal Sentence Encoder
- Relatório automático em texto

## Formato obrigatório do relatório

O relatório é orientado a marca e segue este formato:

- `RELATÓRIO DE GÔNDOLA`
- `Marcas identificadas`
- `Contagem de produtos por marca`
- `Total de itens detectados`
- `Distribuição aproximada na prateleira (esquerda/centro/direita)`
- `Confiança média da identificação por marca`
- `Observações` com indicação de evidências (OCR, padrão visual, modelo de visão e repetição de embalagem)

Regras aplicadas:

- Prioridade para identificação por texto/logotipo via OCR
- Agrupamento de produtos visualmente repetidos na mesma marca
- Nunca usar termos genéricos no resultado
- Quando não houver evidência suficiente para marca específica, usar `Marca não identificada`

## Como executar

### Opção 1: Python

```bash
python -m http.server 8000
```

Depois abra:

- http://localhost:8000

### Opção 2: VS Code Live Server

Abra `index.html` com Live Server.

## Observações importantes

- Este MVP combina COCO-SSD, OCR e heurísticas visuais. Isso melhora casos em que a marca está visível, mas o detector genérico não reconhece a embalagem corretamente.
- Marcas específicas ainda dependem da qualidade da imagem, contraste, oclusão e legibilidade do texto na embalagem.
- Para reconhecimento robusto de marcas reais (Fandangos, Doritos, etc.), o próximo passo é treinar/ajustar um detector customizado (YOLOv8/Roboflow/TFJS).
- O pipeline foi estruturado para facilitar migração para arquitetura híbrida com backend.
