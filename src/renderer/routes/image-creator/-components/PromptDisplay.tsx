import { Flex, Stack, Text } from '@mantine/core'
import { IconPhoto } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'

export interface PromptDisplayProps {
  prompt: string
  modelDisplayName?: string
  model?: { provider: string; modelId: string }
  referenceImageCount: number
}

export function PromptDisplay({ prompt, modelDisplayName, model, referenceImageCount }: PromptDisplayProps) {
  const { t } = useTranslation()
  const resolvedModelDisplayName = modelDisplayName ?? model?.modelId ?? ''

  return (
    <Stack gap={4} align="center" className="text-center">
      <Text size="sm" c="gray.7" style={{ lineHeight: 1.5, maxWidth: '90%' }}>
        {prompt}
      </Text>
      <Flex gap="sm" align="center" justify="center">
        <Text size="xs" c="gray.5">
          {resolvedModelDisplayName}
        </Text>
        {referenceImageCount > 0 && (
          <>
            <Text size="xs" c="gray.5">
              •
            </Text>
            <Flex align="center" gap={4}>
              <IconPhoto size={12} className="opacity-50" />
              <Text size="xs" c="gray.5">
                {t('{{count}} ref', { count: referenceImageCount })}
              </Text>
            </Flex>
          </>
        )}
      </Flex>
    </Stack>
  )
}
