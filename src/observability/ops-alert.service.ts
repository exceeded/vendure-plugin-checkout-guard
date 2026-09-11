import { Injectable } from '@nestjs/common';
import { Logger } from '@vendure/core';
import { fanOutOpsEvent, OpsChannels, OpsEvent } from '../ops-notify';
import { hasPremium, loggerCtx, noteLocked, runtimeOptions } from './runtime';

/**
 * Ops alerts (premium). Fans one event out to every configured chat
 * webhook (`options.ops`) and, when `ops.adminEmail` plus SMTP_* env are
 * present, e-mails it as well. Never throws: a dead webhook must not
 * break a payment flow.
 *
 * SMTP env (same names as the fraud-prevention plugin):
 *   SMTP_SERVER, SMTP_PORT (587), SMTP_USER, SMTP_PASSWORD, SMTP_FROM
 */
@Injectable()
export class OpsAlertService {
    private channels(): OpsChannels {
        const ops = runtimeOptions().ops || {};
        return {
            slackWebhookUrl: ops.slackWebhookUrl || null,
            discordWebhookUrl: ops.discordWebhookUrl || null,
            teamsWebhookUrl: ops.teamsWebhookUrl || null,
            telegramBotToken: ops.telegramBotToken || null,
            telegramChatId: ops.telegramChatId || null,
            genericWebhookUrl: ops.webhookUrl || null,
            genericWebhookSecret: ops.webhookSecret || null,
        };
    }

    /** True when at least one transport is configured. */
    isConfigured(): boolean {
        const c = this.channels();
        return !!(c.slackWebhookUrl || c.discordWebhookUrl || c.teamsWebhookUrl
            || (c.telegramBotToken && c.telegramChatId) || c.genericWebhookUrl
            || (runtimeOptions().ops?.adminEmail && this.smtp()));
    }

    /**
     * Send an alert. Resolves once every transport has settled; callers
     * that must not wait should `void` the promise.
     */
    async alert(ev: OpsEvent): Promise<void> {
        if (!hasPremium()) {
            noteLocked('Ops alerts');
            return;
        }
        try {
            await Promise.allSettled([
                fanOutOpsEvent(this.channels(), ev),
                this.email(ev),
            ]);
        } catch (e: any) {
            Logger.warn(`Ops alert failed: ${e?.message || e}`, loggerCtx);
        }
    }

    private smtp(): { host: string; port: number; user: string; pass: string; from: string } | null {
        if (process.env.SMTP_SERVER && process.env.SMTP_USER) {
            return {
                host: process.env.SMTP_SERVER,
                port: Number(process.env.SMTP_PORT || 587),
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASSWORD || '',
                from: process.env.SMTP_FROM || process.env.SMTP_USER,
            };
        }
        return null;
    }

    private async email(ev: OpsEvent): Promise<void> {
        const to = runtimeOptions().ops?.adminEmail;
        const smtp = this.smtp();
        if (!to || !smtp) return;
        let nodemailer: any;
        try {
            nodemailer = await import('nodemailer');
        } catch {
            Logger.warn('ops.adminEmail is set but the "nodemailer" package is not installed — e-mail alerts disabled', loggerCtx);
            return;
        }
        try {
            const transporter = nodemailer.createTransport({
                host: smtp.host, port: smtp.port, secure: smtp.port === 465,
                auth: { user: smtp.user, pass: smtp.pass },
            });
            const rows = [
                ev.orderCode ? `<tr><td><b>Order</b></td><td>${escapeHtml(ev.orderCode)}</td></tr>` : '',
                (ev.providerRef || ev.paymentIntentId) ? `<tr><td><b>Reference</b></td><td>${escapeHtml(String(ev.providerRef || ev.paymentIntentId))}</td></tr>` : '',
                ev.amountMinor != null ? `<tr><td><b>Amount</b></td><td>${formatMinor(ev.amountMinor, ev.currency)}</td></tr>` : '',
                ev.channelId != null ? `<tr><td><b>Channel</b></td><td>${escapeHtml(String(ev.channelId))}</td></tr>` : '',
            ].join('');
            await transporter.sendMail({
                from: smtp.from, to,
                subject: `[Checkout Guard] ${ev.event}${ev.orderCode ? ` — ${ev.orderCode}` : ''}`,
                html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
                    <p>${escapeHtml(ev.text).replace(/\n/g, '<br>')}</p>
                    ${rows ? `<table cellpadding="4">${rows}</table>` : ''}
                    </div>`,
            });
        } catch (e: any) {
            Logger.warn(`Ops e-mail failed: ${e?.message || e}`, loggerCtx);
        }
    }
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));
}

/** Format minor units for humans: 1234 GBP → "£12.34". Never fabricates a
 *  currency: falls back to the bare number when none is known. */
export function formatMinor(amountMinor: number, currency?: string | null): string {
    const major = amountMinor / 100;
    if (!currency) return major.toFixed(2);
    try {
        return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(major);
    } catch {
        return `${major.toFixed(2)} ${currency}`;
    }
}
