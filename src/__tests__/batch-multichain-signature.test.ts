import {
  type Hex,
  recoverAddress,
  compactSignatureToSignature,
  serializeSignature,
  parseCompactSignature,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  signBatchCompact,
  signMultichainCompact,
  generateBatchClaimHash,
  generateMultichainClaimHash,
  getSigningAddress,
} from '../crypto';
import {
  ValidatedBatchCompactMessage,
  ValidatedMultichainCompactMessage,
} from '../validation/types';

describe('Batch and Multichain Compact Signature Tests', () => {
  const expectedSigner = getSigningAddress();
  const chainId = BigInt(1); // Mainnet

  // Add test to verify private key matches expected signer
  describe('test environment setup', () => {
    it('should have private key that matches expected signer', () => {
      const privateKey = process.env.PRIVATE_KEY as Hex;
      expect(privateKey).toBeDefined();
      const derivedAddress =
        privateKeyToAccount(privateKey).address.toLowerCase();
      expect(derivedAddress).toBe(expectedSigner.toLowerCase());
    });
  });

  describe('BatchCompact Signing', () => {
    const mockBatchCompact: ValidatedBatchCompactMessage = {
      arbiter: '0x0000000000000000000000000000000000000001',
      sponsor: '0x0000000000000000000000000000000000000002',
      nonce: BigInt('0x1'),
      expires: BigInt(Math.floor(Date.now() / 1000) + 3600), // 1 hour from now
      commitments: [
        {
          lockTag: '0x000000000000000000000001',
          token: '0x0000000000000000000000000000000000000003',
          amount: '1000000000000000000', // 1 ETH
        },
        {
          lockTag: '0x000000000000000000000002',
          token: '0x0000000000000000000000000000000000000004',
          amount: '2000000000000000000', // 2 ETH
        },
      ],
      witnessTypeString: null,
      witnessHash: null,
    };

    describe('generateBatchClaimHash', () => {
      it('should generate a valid claim hash for batch compact', async () => {
        const hash = await generateBatchClaimHash(mockBatchCompact);
        expect(hash).toMatch(/^0x[a-fA-F0-9]{64}$/);
      });

      it('should generate different hashes for different nonces', async () => {
        const hash1 = await generateBatchClaimHash(mockBatchCompact);
        const hash2 = await generateBatchClaimHash({
          ...mockBatchCompact,
          nonce: BigInt('0x2'),
        });
        expect(hash1).not.toBe(hash2);
      });

      it('should generate different hashes for different commitments', async () => {
        const hash1 = await generateBatchClaimHash(mockBatchCompact);
        const hash2 = await generateBatchClaimHash({
          ...mockBatchCompact,
          commitments: [
            {
              lockTag: '0x000000000000000000000003',
              token: '0x0000000000000000000000000000000000000005',
              amount: '3000000000000000000',
            },
          ],
        });
        expect(hash1).not.toBe(hash2);
      });

      it('should generate consistent hashes regardless of commitment order', async () => {
        const batchCompact1: ValidatedBatchCompactMessage = {
          ...mockBatchCompact,
          commitments: [
            {
              lockTag: '0x000000000000000000000001',
              token: '0x0000000000000000000000000000000000000003',
              amount: '1000000000000000000',
            },
            {
              lockTag: '0x000000000000000000000002',
              token: '0x0000000000000000000000000000000000000004',
              amount: '2000000000000000000',
            },
          ],
        };

        const batchCompact2: ValidatedBatchCompactMessage = {
          ...mockBatchCompact,
          commitments: [
            {
              lockTag: '0x000000000000000000000002',
              token: '0x0000000000000000000000000000000000000004',
              amount: '2000000000000000000',
            },
            {
              lockTag: '0x000000000000000000000001',
              token: '0x0000000000000000000000000000000000000003',
              amount: '1000000000000000000',
            },
          ],
        };

        const hash1 = await generateBatchClaimHash(batchCompact1);
        const hash2 = await generateBatchClaimHash(batchCompact2);
        expect(hash1).toBe(hash2);
      });

      it('should generate valid hash with witness data', async () => {
        const batchCompactWithWitness: ValidatedBatchCompactMessage = {
          ...mockBatchCompact,
          witnessTypeString: 'bytes32 witnessHash',
          witnessHash:
            '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex,
        };

        const hash = await generateBatchClaimHash(batchCompactWithWitness);
        expect(hash).toMatch(/^0x[a-fA-F0-9]{64}$/);

        // Should generate different hash than without witness
        const hashWithoutWitness =
          await generateBatchClaimHash(mockBatchCompact);
        expect(hash).not.toBe(hashWithoutWitness);
      });
    });

    describe('signBatchCompact', () => {
      it('should generate a valid EIP2098 compact signature', async () => {
        const { digest, signature: signaturePromise } = await signBatchCompact(
          mockBatchCompact,
          chainId
        );
        const compactSig = await signaturePromise;

        // EIP2098 signatures should be 64 bytes (128 hex chars) without the 0x prefix
        expect(compactSig).toMatch(/^0x[a-fA-F0-9]{128}$/);

        // Convert compact signature to full signature
        const parsedCompactSig = parseCompactSignature(compactSig);
        const signature = compactSignatureToSignature(parsedCompactSig);
        const fullSignature = serializeSignature(signature);

        // Recover and verify the signer
        const recoveredAddress = await recoverAddress({
          hash: digest,
          signature: fullSignature,
        });
        expect(recoveredAddress.toLowerCase()).toBe(
          expectedSigner.toLowerCase()
        );
      });

      it('should generate consistent signatures for the same batch compact', async () => {
        const { digest, signature: sig1Promise } = await signBatchCompact(
          mockBatchCompact,
          chainId
        );
        const { signature: sig2Promise } = await signBatchCompact(
          mockBatchCompact,
          chainId
        );
        const sig1 = await sig1Promise;
        const sig2 = await sig2Promise;
        expect(sig1).toBe(sig2);

        // Convert compact signature to full signature
        const parsedCompactSig = parseCompactSignature(sig1);
        const signature = compactSignatureToSignature(parsedCompactSig);
        const fullSignature = serializeSignature(signature);

        // Recover and verify the signer
        const recoveredAddress = await recoverAddress({
          hash: digest,
          signature: fullSignature,
        });
        expect(recoveredAddress.toLowerCase()).toBe(
          expectedSigner.toLowerCase()
        );
      });

      it('should generate different signatures for different nonces', async () => {
        const { digest: digest1, signature: sig1Promise } =
          await signBatchCompact(mockBatchCompact, chainId);
        const { digest: digest2, signature: sig2Promise } =
          await signBatchCompact(
            {
              ...mockBatchCompact,
              nonce: BigInt('0x2'),
            },
            chainId
          );
        const sig1 = await sig1Promise;
        const sig2 = await sig2Promise;
        expect(sig1).not.toBe(sig2);

        // Verify both signatures
        const parsedCompactSig1 = parseCompactSignature(sig1);
        const signature1 = compactSignatureToSignature(parsedCompactSig1);
        const fullSignature1 = serializeSignature(signature1);

        const parsedCompactSig2 = parseCompactSignature(sig2);
        const signature2 = compactSignatureToSignature(parsedCompactSig2);
        const fullSignature2 = serializeSignature(signature2);

        const recoveredAddress1 = await recoverAddress({
          hash: digest1,
          signature: fullSignature1,
        });
        const recoveredAddress2 = await recoverAddress({
          hash: digest2,
          signature: fullSignature2,
        });

        expect(recoveredAddress1.toLowerCase()).toBe(
          expectedSigner.toLowerCase()
        );
        expect(recoveredAddress2.toLowerCase()).toBe(
          expectedSigner.toLowerCase()
        );
      });

      it('should generate valid signatures with witness data', async () => {
        const batchCompactWithWitness: ValidatedBatchCompactMessage = {
          ...mockBatchCompact,
          witnessTypeString: 'bytes32 witnessHash',
          witnessHash:
            '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex,
        };

        const { digest, signature: signaturePromise } = await signBatchCompact(
          batchCompactWithWitness,
          chainId
        );
        const compactSig = await signaturePromise;

        // Should still produce a valid EIP2098 signature
        expect(compactSig).toMatch(/^0x[a-fA-F0-9]{128}$/);

        // Convert compact signature to full signature
        const parsedCompactSig = parseCompactSignature(compactSig);
        const signature = compactSignatureToSignature(parsedCompactSig);
        const fullSignature = serializeSignature(signature);

        // Recover and verify the signer
        const recoveredAddress = await recoverAddress({
          hash: digest,
          signature: fullSignature,
        });
        expect(recoveredAddress.toLowerCase()).toBe(
          expectedSigner.toLowerCase()
        );
      });

      it('should handle multiple commitments correctly', async () => {
        const batchWithManyCommitments: ValidatedBatchCompactMessage = {
          ...mockBatchCompact,
          commitments: [
            {
              lockTag: '0x000000000000000000000001',
              token: '0x0000000000000000000000000000000000000003',
              amount: '1000000000000000000',
            },
            {
              lockTag: '0x000000000000000000000002',
              token: '0x0000000000000000000000000000000000000004',
              amount: '2000000000000000000',
            },
            {
              lockTag: '0x000000000000000000000003',
              token: '0x0000000000000000000000000000000000000005',
              amount: '3000000000000000000',
            },
          ],
        };

        const { digest, signature: signaturePromise } = await signBatchCompact(
          batchWithManyCommitments,
          chainId
        );
        const compactSig = await signaturePromise;

        expect(compactSig).toMatch(/^0x[a-fA-F0-9]{128}$/);

        const parsedCompactSig = parseCompactSignature(compactSig);
        const signature = compactSignatureToSignature(parsedCompactSig);
        const fullSignature = serializeSignature(signature);

        const recoveredAddress = await recoverAddress({
          hash: digest,
          signature: fullSignature,
        });
        expect(recoveredAddress.toLowerCase()).toBe(
          expectedSigner.toLowerCase()
        );
      });
    });
  });

  describe('MultichainCompact Signing', () => {
    const mockMultichainCompact: ValidatedMultichainCompactMessage = {
      sponsor: '0x0000000000000000000000000000000000000002',
      nonce: BigInt('0x1'),
      expires: BigInt(Math.floor(Date.now() / 1000) + 3600), // 1 hour from now
      witnessTypeString: 'bytes32 witnessHash',
      elements: [
        {
          arbiter: '0x0000000000000000000000000000000000000001',
          chainId: BigInt(1), // Mainnet
          commitments: [
            {
              lockTag: '0x000000000000000000000001',
              token: '0x0000000000000000000000000000000000000003',
              amount: '1000000000000000000',
            },
          ],
          witnessHash:
            '0x0000000000000000000000000000000000000000000000000000000000000001',
        },
        {
          arbiter: '0x0000000000000000000000000000000000000004',
          chainId: BigInt(137), // Polygon
          commitments: [
            {
              lockTag: '0x000000000000000000000002',
              token: '0x0000000000000000000000000000000000000005',
              amount: '2000000000000000000',
            },
          ],
          witnessHash:
            '0x0000000000000000000000000000000000000000000000000000000000000002',
        },
      ],
    };

    const notarizedChainId = BigInt(1); // Mainnet as notarization chain

    describe('generateMultichainClaimHash', () => {
      it('should generate a valid claim hash for multichain compact', async () => {
        const hash = await generateMultichainClaimHash(
          mockMultichainCompact,
          notarizedChainId,
          mockMultichainCompact.witnessTypeString
        );
        expect(hash).toMatch(/^0x[a-fA-F0-9]{64}$/);
      });

      it('should generate different hashes for different nonces', async () => {
        const hash1 = await generateMultichainClaimHash(
          mockMultichainCompact,
          notarizedChainId,
          mockMultichainCompact.witnessTypeString
        );
        const hash2 = await generateMultichainClaimHash(
          {
            ...mockMultichainCompact,
            nonce: BigInt('0x2'),
          },
          notarizedChainId,
          mockMultichainCompact.witnessTypeString
        );
        expect(hash1).not.toBe(hash2);
      });

      it('should generate different hashes for different elements', async () => {
        const hash1 = await generateMultichainClaimHash(
          mockMultichainCompact,
          notarizedChainId,
          mockMultichainCompact.witnessTypeString
        );

        const modifiedCompact: ValidatedMultichainCompactMessage = {
          ...mockMultichainCompact,
          elements: [
            {
              arbiter: '0x0000000000000000000000000000000000000006',
              chainId: BigInt(10), // Optimism
              commitments: [
                {
                  lockTag: '0x000000000000000000000003',
                  token: '0x0000000000000000000000000000000000000007',
                  amount: '3000000000000000000',
                },
              ],
              witnessHash:
                '0x0000000000000000000000000000000000000000000000000000000000000003',
            },
          ],
        };

        const hash2 = await generateMultichainClaimHash(
          modifiedCompact,
          notarizedChainId,
          mockMultichainCompact.witnessTypeString
        );
        expect(hash1).not.toBe(hash2);
      });

      it('should generate different hashes for different witness type strings', async () => {
        const hash1 = await generateMultichainClaimHash(
          mockMultichainCompact,
          notarizedChainId,
          'bytes32 witnessHash'
        );
        const hash2 = await generateMultichainClaimHash(
          mockMultichainCompact,
          notarizedChainId,
          'bytes data'
        );
        expect(hash1).not.toBe(hash2);
      });
    });

    describe('signMultichainCompact', () => {
      it('should generate a valid EIP2098 compact signature', async () => {
        const { digest, signature: signaturePromise } =
          await signMultichainCompact(
            mockMultichainCompact,
            notarizedChainId,
            mockMultichainCompact.witnessTypeString
          );
        const compactSig = await signaturePromise;

        // EIP2098 signatures should be 64 bytes (128 hex chars) without the 0x prefix
        expect(compactSig).toMatch(/^0x[a-fA-F0-9]{128}$/);

        // Convert compact signature to full signature
        const parsedCompactSig = parseCompactSignature(compactSig);
        const signature = compactSignatureToSignature(parsedCompactSig);
        const fullSignature = serializeSignature(signature);

        // Recover and verify the signer
        const recoveredAddress = await recoverAddress({
          hash: digest,
          signature: fullSignature,
        });
        expect(recoveredAddress.toLowerCase()).toBe(
          expectedSigner.toLowerCase()
        );
      });

      it('should generate consistent signatures for the same multichain compact', async () => {
        const { digest, signature: sig1Promise } = await signMultichainCompact(
          mockMultichainCompact,
          notarizedChainId,
          mockMultichainCompact.witnessTypeString
        );
        const { signature: sig2Promise } = await signMultichainCompact(
          mockMultichainCompact,
          notarizedChainId,
          mockMultichainCompact.witnessTypeString
        );
        const sig1 = await sig1Promise;
        const sig2 = await sig2Promise;
        expect(sig1).toBe(sig2);

        // Convert compact signature to full signature
        const parsedCompactSig = parseCompactSignature(sig1);
        const signature = compactSignatureToSignature(parsedCompactSig);
        const fullSignature = serializeSignature(signature);

        // Recover and verify the signer
        const recoveredAddress = await recoverAddress({
          hash: digest,
          signature: fullSignature,
        });
        expect(recoveredAddress.toLowerCase()).toBe(
          expectedSigner.toLowerCase()
        );
      });

      it('should generate different signatures for different nonces', async () => {
        const { digest: digest1, signature: sig1Promise } =
          await signMultichainCompact(
            mockMultichainCompact,
            notarizedChainId,
            mockMultichainCompact.witnessTypeString
          );
        const { digest: digest2, signature: sig2Promise } =
          await signMultichainCompact(
            {
              ...mockMultichainCompact,
              nonce: BigInt('0x2'),
            },
            notarizedChainId,
            mockMultichainCompact.witnessTypeString
          );
        const sig1 = await sig1Promise;
        const sig2 = await sig2Promise;
        expect(sig1).not.toBe(sig2);

        // Verify both signatures
        const parsedCompactSig1 = parseCompactSignature(sig1);
        const signature1 = compactSignatureToSignature(parsedCompactSig1);
        const fullSignature1 = serializeSignature(signature1);

        const parsedCompactSig2 = parseCompactSignature(sig2);
        const signature2 = compactSignatureToSignature(parsedCompactSig2);
        const fullSignature2 = serializeSignature(signature2);

        const recoveredAddress1 = await recoverAddress({
          hash: digest1,
          signature: fullSignature1,
        });
        const recoveredAddress2 = await recoverAddress({
          hash: digest2,
          signature: fullSignature2,
        });

        expect(recoveredAddress1.toLowerCase()).toBe(
          expectedSigner.toLowerCase()
        );
        expect(recoveredAddress2.toLowerCase()).toBe(
          expectedSigner.toLowerCase()
        );
      });

      it('should handle multiple elements correctly', async () => {
        const multichainWithManyElements: ValidatedMultichainCompactMessage = {
          ...mockMultichainCompact,
          elements: [
            {
              arbiter: '0x0000000000000000000000000000000000000001',
              chainId: BigInt(1), // Mainnet
              commitments: [
                {
                  lockTag: '0x000000000000000000000001',
                  token: '0x0000000000000000000000000000000000000003',
                  amount: '1000000000000000000',
                },
              ],
              witnessHash:
                '0x0000000000000000000000000000000000000000000000000000000000000001',
            },
            {
              arbiter: '0x0000000000000000000000000000000000000004',
              chainId: BigInt(137), // Polygon
              commitments: [
                {
                  lockTag: '0x000000000000000000000002',
                  token: '0x0000000000000000000000000000000000000005',
                  amount: '2000000000000000000',
                },
              ],
              witnessHash:
                '0x0000000000000000000000000000000000000000000000000000000000000002',
            },
            {
              arbiter: '0x0000000000000000000000000000000000000006',
              chainId: BigInt(10), // Optimism
              commitments: [
                {
                  lockTag: '0x000000000000000000000003',
                  token: '0x0000000000000000000000000000000000000007',
                  amount: '3000000000000000000',
                },
              ],
              witnessHash:
                '0x0000000000000000000000000000000000000000000000000000000000000003',
            },
          ],
        };

        const { digest, signature: signaturePromise } =
          await signMultichainCompact(
            multichainWithManyElements,
            notarizedChainId,
            mockMultichainCompact.witnessTypeString
          );
        const compactSig = await signaturePromise;

        expect(compactSig).toMatch(/^0x[a-fA-F0-9]{128}$/);

        const parsedCompactSig = parseCompactSignature(compactSig);
        const signature = compactSignatureToSignature(parsedCompactSig);
        const fullSignature = serializeSignature(signature);

        const recoveredAddress = await recoverAddress({
          hash: digest,
          signature: fullSignature,
        });
        expect(recoveredAddress.toLowerCase()).toBe(
          expectedSigner.toLowerCase()
        );
      });

      it('should handle elements with multiple commitments', async () => {
        const multichainWithMultipleCommitments: ValidatedMultichainCompactMessage =
          {
            ...mockMultichainCompact,
            elements: [
              {
                arbiter: '0x0000000000000000000000000000000000000001',
                chainId: BigInt(1),
                commitments: [
                  {
                    lockTag: '0x000000000000000000000001',
                    token: '0x0000000000000000000000000000000000000003',
                    amount: '1000000000000000000',
                  },
                  {
                    lockTag: '0x000000000000000000000002',
                    token: '0x0000000000000000000000000000000000000004',
                    amount: '2000000000000000000',
                  },
                  {
                    lockTag: '0x000000000000000000000003',
                    token: '0x0000000000000000000000000000000000000005',
                    amount: '3000000000000000000',
                  },
                ],
                witnessHash:
                  '0x0000000000000000000000000000000000000000000000000000000000000001',
              },
            ],
          };

        const { digest, signature: signaturePromise } =
          await signMultichainCompact(
            multichainWithMultipleCommitments,
            notarizedChainId,
            mockMultichainCompact.witnessTypeString
          );
        const compactSig = await signaturePromise;

        expect(compactSig).toMatch(/^0x[a-fA-F0-9]{128}$/);

        const parsedCompactSig = parseCompactSignature(compactSig);
        const signature = compactSignatureToSignature(parsedCompactSig);
        const fullSignature = serializeSignature(signature);

        const recoveredAddress = await recoverAddress({
          hash: digest,
          signature: fullSignature,
        });
        expect(recoveredAddress.toLowerCase()).toBe(
          expectedSigner.toLowerCase()
        );
      });
    });
  });
});
