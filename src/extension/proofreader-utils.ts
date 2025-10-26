import React from 'react';
import { sendToBackground } from "./messaging";
import { proofreaderState, type ProofreaderCorrection, type ProofreaderState, getCurrentSession, updateSession, clearSession } from "./proofreader-state";

// Dialog management functions

export async function showProofreaderDialog(selectedText: string) {
  console.log('showProofreaderDialog called with text:', selectedText);

  // Note: Selection range and session are now managed in content script context
  // The content script creates the session when the dialog is triggered

  // Update local state
  const session = getCurrentSession();
  proofreaderState.activeSession = session;
  proofreaderState.isVisible = true;
  proofreaderState.selectedText = selectedText;
  proofreaderState.corrections = [];
  proofreaderState.isLoading = true;
  proofreaderState.error = null;

  console.log('Updated proofreader state:', proofreaderState);

  // Send message to background to open side panel and switch to proofreader tab
  try {
    console.log('📤 Sending OPEN_PROOFREADER message');
    const response = await sendToBackground({
      type: "OPEN_PROOFREADER",
      payload: {
        text: selectedText,
        sessionId: session?.id
      }
    });

    console.log('✅ OPEN_PROOFREADER response received:', response.type);

    if (response.type === "ACK") {
      console.log('🎉 Proofreader dialog opened successfully');
    } else if (response.type === "ERROR") {
      console.error('❌ Failed to open proofreader:', response.message);
      proofreaderState.error = response.message;
      proofreaderState.isVisible = false;
    }
  } catch (error) {
    console.error('❌ Failed to open proofreader in side panel:', error);
    proofreaderState.error = error instanceof Error ? error.message : "Failed to open proofreader. Please try again.";
    proofreaderState.isVisible = false;

    // Still try to run proofreader even if sidepanel failed
    try {
      await runProofreaderForSelection(selectedText);
    } catch (proofreadError) {
      console.error('❌ Proofreader also failed:', proofreadError);
      proofreaderState.error = "Both sidepanel and proofreader failed. Please reload the extension.";
    }
  }

  // Run proofreader API regardless of sidepanel success
  runProofreaderForSelection(selectedText);
}

export async function runProofreaderForSelection(text: string) {
  try {
    console.log('🔍 Running proofreader for selection:', text);
    const session = getCurrentSession();
    const response = await sendToBackground({
      type: "PROOFREAD_SELECTED_TEXT",
      payload: {
        text: text,
        fieldId: "selection",
        sessionId: session?.id
      }
    });

    console.log('✅ Proofreader response received:', response.type);

    if (response.type === "PROOFREADER_FIELD_RESULT") {
      const result = response.payload;
      console.log('📋 Proofreader result:', result);

      // Update the session with the corrections
      const session = getCurrentSession();
      if (session) {
        session.corrections = result.corrections || [];
        session.correctedText = result.corrected || null; // Store the final corrected text
        session.isLoading = false;
        session.error = result.ok ? null : result.message || "Proofreader error";
        updateSession(session);
        console.log('📝 Updated session with corrections:', session.corrections.length);
        console.log('📝 Stored corrected text:', session.correctedText);

        // Reset session if proofreader failed
        if (!result.ok) {
          console.log('❌ Proofreader failed, resetting session');
          clearSession();
        }
      }

      proofreaderState.corrections = result.corrections || [];
      proofreaderState.isLoading = false;
      proofreaderState.error = result.ok ? null : result.message || "Proofreader error";
      proofreaderState.correctedText = result.corrected || null;

      // Send state update to side panel
      await sendStateUpdate();
    } else {
      console.error('❌ Unexpected response type:', response.type);
      // Update session with error
      const session = getCurrentSession();
      if (session) {
        session.isLoading = false;
        session.corrections = [];
        session.error = "Unexpected response format";
        updateSession(session);
        clearSession(); // Reset session on unexpected response
      }

      proofreaderState.isLoading = false;
      proofreaderState.corrections = [];
      proofreaderState.error = "Unexpected response format";
      proofreaderState.correctedText = null;

      // Send state update to side panel
      await sendStateUpdate();
    }
  } catch (error) {
    console.error('❌ Proofreader error:', error);

    // Update session with error
    const session = getCurrentSession();
    if (session) {
      session.isLoading = false;
      session.corrections = [];
      session.error = "Error occurred";
      updateSession(session);
      clearSession(); // Reset session on error
    }

    proofreaderState.isLoading = false;
    proofreaderState.corrections = [];
    proofreaderState.error = "Error occurred";
    proofreaderState.correctedText = null;

    // Send state update to side panel
    await sendStateUpdate();
  }
}

async function sendStateUpdate() {
  try {
    console.log('📤 Sending PROOFREADER_STATE_UPDATED message to sidepanel');
    console.log('📋 State data:', {
      text: proofreaderState.selectedText,
      isVisible: proofreaderState.isVisible,
      isLoading: proofreaderState.isLoading,
      corrections: proofreaderState.corrections.length,
      error: proofreaderState.error,
      sessionId: proofreaderState.sessionId,
      correctedText: proofreaderState.correctedText
    });

    // Send as a runtime message since it's an event, not a request
    chrome.runtime.sendMessage({
      type: "PROOFREADER_STATE_UPDATED",
      payload: {
        text: proofreaderState.selectedText,
        isVisible: proofreaderState.isVisible,
        isLoading: proofreaderState.isLoading,
        corrections: proofreaderState.corrections,
        error: proofreaderState.error,
        sessionId: proofreaderState.sessionId,
        correctedText: proofreaderState.correctedText
      }
    });

    console.log('✅ PROOFREADER_STATE_UPDATED message sent successfully');
  } catch (error) {
    console.error('❌ Failed to send proofreader state update:', error);
  }
}

export async function hideProofreaderDialog() {
  console.log('hideProofreaderDialog called');

  // Clear the session
  proofreaderState.activeSession = null;
  proofreaderState.isVisible = false;
  proofreaderState.selectedText = '';
  proofreaderState.corrections = [];
  proofreaderState.error = null;
  proofreaderState.correctedText = null;

  // Send state update to side panel
  await sendStateUpdate();
}

export function renderProofreaderDialog() {
  // This function is called from content-script.tsx but we don't need to implement it
  // since we're using the sidepanel approach instead of a floating dialog
  console.log('renderProofreaderDialog called - using sidepanel approach');
}
