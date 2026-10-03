import type { AIStepConfig, StepDefinition, WorkflowGraph } from '@core/types'

const conceptSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['concepts'],
  properties: {
    concepts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'description'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' }
        }
      }
    }
  }
}

const shotSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['shots'],
  properties: {
    shots: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'description'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          camera: { type: 'string' },
          lighting: { type: 'string' }
        }
      }
    }
  }
}

const identifierSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['product_identifiers'],
  properties: {
    product_identifiers: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'category', 'colors', 'materials', 'branding', 'packaging', 'visible_text', 'distinctive_features'],
      properties: {
        name: { type: 'string' },
        category: { type: 'string' },
        colors: { type: 'array', items: { type: 'string' } },
        materials: { type: 'array', items: { type: 'string' } },
        branding: { type: 'string' },
        packaging: { type: 'string' },
        visible_text: { type: 'array', items: { type: 'string' } },
        distinctive_features: { type: 'array', items: { type: 'string' } }
      }
    }
  }
}

const passportSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['product_passport'],
  properties: {
    product_passport: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'visual_identity', 'do_not_change', 'mood'],
      properties: {
        summary: { type: 'string' },
        visual_identity: { type: 'string' },
        do_not_change: { type: 'array', items: { type: 'string' } },
        mood: { type: 'string' }
      }
    }
  }
}

const bananaSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['subject', 'composition', 'lighting', 'camera', 'environment', 'color', 'constraints'],
  properties: {
    subject: { type: 'object' },
    composition: { type: 'object' },
    lighting: { type: 'object' },
    camera: { type: 'object' },
    environment: { type: 'object' },
    color: { type: 'object' },
    constraints: { type: 'object' }
  }
}

function ai(
  id: string,
  key: string,
  name: string,
  order: number,
  dependsOn: string[],
  config: AIStepConfig,
  iterate: StepDefinition['iterate'] = null
): StepDefinition {
  return {
    id,
    key,
    name,
    description: '',
    type: 'ai',
    order,
    dependsOn,
    stopAfter: false,
    iterate,
    config
  }
}

function message(id: string, role: 'system' | 'user', content: string) {
  return { id, role, content }
}

export function createNeurophotoGraph(): WorkflowGraph {
  const identifiers = '11111111-1111-4111-8111-111111111111'
  const passport = '22222222-2222-4222-8222-222222222222'
  const concepts = '33333333-3333-4333-8333-333333333333'
  const selection = '44444444-4444-4444-8444-444444444444'
  const shots = '55555555-5555-4555-8555-555555555555'
  const review = '66666666-6666-4666-8666-666666666666'
  const banana = '77777777-7777-4777-8777-777777777777'

  return {
    inputs: [
      {
        id: 'in-product-image',
        name: 'product_image',
        label: 'Исходное фото продукта',
        type: 'image',
        required: true,
        description: 'Одно изображение, по которому сохраняется геометрия и упаковка.'
      },
      {
        id: 'in-additional-images',
        name: 'additional_images',
        label: 'Дополнительные изображения',
        type: 'image[]',
        required: false,
        description: 'Ракурсы, детали, референсы.'
      },
      {
        id: 'in-instruction',
        name: 'additional_instruction',
        label: 'Дополнительные указания',
        type: 'text',
        required: false,
        description: 'Любые ограничения или пожелания к съёмке.'
      }
    ],
    steps: [
      ai(identifiers, 'product_identifiers', 'Product Identifier Generator', 1, [], {
        provider: 'openai',
        model: 'gpt-4.1',
        temperature: 0.2,
        outputFormat: 'json',
        jsonSchema: identifierSchema,
        messages: [
          message(
            'm-id-system',
            'system',
            'You are an expert commercial product analyst. Identify only what is visible. Do not invent logos, flavor names, or claims that are not in the images.'
          ),
          message(
            'm-id-user',
            'user',
            'Product image:\n{{inputs.product_image}}\n\nAdditional images:\n{{inputs.additional_images}}\n\nInstructions:\n{{inputs.additional_instruction}}\n\nReturn product identifiers.'
          )
        ]
      }),
      ai(passport, 'product_passport', 'Product Passport Generator', 2, [identifiers], {
        provider: 'openai',
        model: 'gpt-4.1',
        temperature: 0.3,
        outputFormat: 'json',
        jsonSchema: passportSchema,
        messages: [
          message(
            'm-pass-system',
            'system',
            'You write a product passport for a commercial photoshoot. Preserve exact geometry, branding, packaging, text and visual identity. Separate observed facts from creative direction.'
          ),
          message(
            'm-pass-user',
            'user',
            'Product image:\n{{inputs.product_image}}\n\nProduct identifiers:\n{{steps.product_identifiers.output.product_identifiers}}\n\nInstructions:\n{{inputs.additional_instruction}}'
          )
        ]
      }),
      ai(concepts, 'concept_generator', 'Concept Generator', 3, [passport], {
        provider: 'openai',
        model: 'gpt-4.1',
        temperature: 0.8,
        outputFormat: 'json',
        jsonSchema: conceptSchema,
        messages: [
          message(
            'm-con-system',
            'system',
            'You are a commercial product photographer and art director. Propose exactly 10 distinct campaign concepts. Each concept needs a short id, title and description. Do not redesign the product.'
          ),
          message(
            'm-con-user',
            'user',
            'Product image:\n{{inputs.product_image}}\n\nProduct identifiers:\n{{steps.product_identifiers.output.product_identifiers}}\n\nProduct passport:\n{{steps.product_passport.output.product_passport}}\n\nInstructions:\n{{inputs.additional_instruction}}'
          )
        ]
      }),
      {
        id: selection,
        key: 'concept_selection',
        name: 'Concept Selection',
        description: 'Пользователь выбирает концепции, для которых нужно сгенерировать кадры.',
        type: 'manual',
        order: 4,
        dependsOn: [concepts],
        stopAfter: false,
        iterate: null,
        config: {
          mode: 'select_many',
          source: '{{steps.concept_generator.output.concepts}}',
          labelField: 'title',
          descriptionField: 'description',
          prompt: 'Выберите концепции',
          allowEmpty: false
        }
      },
      ai(
        shots,
        'shot_generator',
        'Shot Generator',
        5,
        [selection],
        {
          provider: 'openai',
          model: 'gpt-4.1',
          temperature: 0.7,
          outputFormat: 'json',
          jsonSchema: shotSchema,
          messages: [
            message(
              'm-shot-system',
              'system',
              'You are a commercial product photographer. For the given concept, propose exactly 10 shots. Keep the product geometry, branding, packaging and text unchanged.'
            ),
            message(
              'm-shot-user',
              'user',
              'Product identifiers:\n{{steps.product_identifiers.output.product_identifiers}}\n\nProduct passport:\n{{steps.product_passport.output.product_passport}}\n\nSelected concept:\n{{current_item}}\n\nInstructions:\n{{inputs.additional_instruction}}'
            )
          ]
        },
        { over: '{{steps.concept_selection.output}}', alias: 'concept', launch: 'all' }
      ),
      {
        id: review,
        key: 'shot_review',
        name: 'Shot Review',
        description: 'Необязательный отбор кадров перед промптом.',
        type: 'manual',
        order: 6,
        dependsOn: [shots],
        stopAfter: false,
        iterate: null,
        config: {
          mode: 'select_many',
          source: '{{steps.shot_generator.output.shots}}',
          labelField: 'title',
          descriptionField: 'description',
          prompt: 'Выберите кадры для промпта',
          allowEmpty: true
        }
      },
      ai(
        banana,
        'banana_prompt',
        'Banana Prompt Generator',
        7,
        [review],
        {
          provider: 'openai',
          model: 'gpt-4.1',
          temperature: 0.4,
          outputFormat: 'json',
          jsonSchema: bananaSchema,
          messages: [
            message(
              'm-ban-system',
              'system',
              'Generate a structured JSON prompt for Nano Banana.\n\nPreserve the exact product geometry, branding, packaging, text and visual identity.\nDo not add new logos, flavors, or label text.\nThe prompt must be specific enough for a still-life product photograph.'
            ),
            message(
              'm-ban-user',
              'user',
              'Product identifiers:\n{{steps.product_identifiers.output.product_identifiers}}\n\nProduct passport:\n{{steps.product_passport.output.product_passport}}\n\nShot:\n{{current_shot}}'
            )
          ]
        },
        { over: '{{steps.shot_review.output}}', alias: 'current_shot', launch: 'manual' }
      )
    ]
  }
}
