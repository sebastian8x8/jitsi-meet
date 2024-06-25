import i18n from 'i18next';
import { batch } from 'react-redux';

import { IStore } from '../app/types';
import { IStateful } from '../base/app/types';
import {
    CONFERENCE_JOINED,
    CONFERENCE_JOIN_IN_PROGRESS,
    ENDPOINT_MESSAGE_RECEIVED,
    UPDATE_CONFERENCE_METADATA
} from '../base/conference/actionTypes';
import { SET_CONFIG } from '../base/config/actionTypes';
import { CONNECTION_FAILED } from '../base/connection/actionTypes';
import { connect, setPreferVisitor } from '../base/connection/actions';
import { disconnect } from '../base/connection/actions.any';
import { JitsiConferenceEvents, JitsiConnectionErrors } from '../base/lib-jitsi-meet';
import { PARTICIPANT_UPDATED } from '../base/participants/actionTypes';
import { raiseHand } from '../base/participants/actions';
import {
    getLocalParticipant,
    getParticipantById,
    isLocalParticipantModerator,
    isParticipantModerator
} from '../base/participants/functions';
import MiddlewareRegistry from '../base/redux/MiddlewareRegistry';
import { toState } from '../base/redux/functions';
import { BUTTON_TYPES } from '../base/ui/constants.any';
import { hideNotification, showNotification } from '../notifications/actions';
import {
    NOTIFICATION_ICON,
    NOTIFICATION_TIMEOUT_TYPE,
    VISITORS_PROMOTION_NOTIFICATION_ID
} from '../notifications/constants';
import { INotificationProps } from '../notifications/types';
import { open as openParticipantsPane } from '../participants-pane/actions';
import { joinConference } from '../prejoin/actions';

import {
    approveRequest,
    clearPromotionRequest,
    denyRequest,
    promotionRequestReceived, setInVisitorsQueue,
    setVisitorDemoteActor,
    setVisitorsSupported,
    updateVisitorsCount
} from './actions';
import { VISITORS_LIVE_ID } from './constants';
import { getPromotionRequests } from './functions';
import logger from './logger';
import { WebsocketClient } from './websocket-client';

MiddlewareRegistry.register(({ dispatch, getState }) => next => action => {
    switch (action.type) {
    case CONFERENCE_JOIN_IN_PROGRESS: {
        const { conference } = action;

        conference.on(JitsiConferenceEvents.PROPERTIES_CHANGED, (properties: { 'visitor-count': number; }) => {
            const visitorCount = Number(properties?.['visitor-count']);

            if (!isNaN(visitorCount) && getState()['features/visitors'].count !== visitorCount) {
                dispatch(updateVisitorsCount(visitorCount));
            }
        });
        break;
    }
    case CONFERENCE_JOINED: {
        const { conference } = action;

        if (getState()['features/visitors'].iAmVisitor) {
            const { demoteActorDisplayName } = getState()['features/visitors'];

            dispatch(setVisitorDemoteActor(undefined));

            const notificationParams: INotificationProps = {
                titleKey: 'visitors.notification.title',
                descriptionKey: 'visitors.notification.description'
            };

            if (demoteActorDisplayName) {
                notificationParams.descriptionKey = 'visitors.notification.demoteDescription';
                notificationParams.descriptionArguments = {
                    actor: demoteActorDisplayName
                };
            }

            // check for demote actor and update notification
            dispatch(showNotification(notificationParams, NOTIFICATION_TIMEOUT_TYPE.STICKY));
        } else {
            dispatch(setVisitorsSupported(conference.isVisitorsSupported()));
            conference.on(JitsiConferenceEvents.VISITORS_SUPPORTED_CHANGED, (value: boolean) => {
                dispatch(setVisitorsSupported(value));
            });
        }

        conference.on(JitsiConferenceEvents.VISITORS_MESSAGE, (
                msg: { action: string; actor: string; from: string; id: string; nick: string; on: boolean; }) => {

            if (msg.action === 'demote-request') {
                // we need it before the disconnect
                const participantById = getParticipantById(getState, msg.actor);
                const localParticipant = getLocalParticipant(getState);

                if (localParticipant && localParticipant.id === msg.id) {
                    // handle demote
                    dispatch(disconnect(true))
                        .then(() => dispatch(setPreferVisitor(true)))
                        .then(() => {
                            // we need to set the name, so we can use it later in the notification
                            if (participantById) {
                                dispatch(setVisitorDemoteActor(participantById.name));
                            }

                            return dispatch(connect());
                        });
                }
            } else if (msg.action === 'promotion-request') {
                const request = {
                    from: msg.from,
                    nick: msg.nick
                };

                if (msg.on) {
                    dispatch(promotionRequestReceived(request));
                } else {
                    dispatch(clearPromotionRequest(request));
                }
                _handlePromotionNotification({
                    dispatch,
                    getState
                });
            } else {
                logger.error('Unknown action:', msg.action);
            }
        });

        conference.on(JitsiConferenceEvents.VISITORS_REJECTION, () => {
            dispatch(raiseHand(false));
        });

        break;
    }
    case ENDPOINT_MESSAGE_RECEIVED: {
        const { data } = action;

        if (data?.action === 'promotion-response' && data.approved) {
            const request = getPromotionRequests(getState())
                .find((r: any) => r.from === data.id);

            request && dispatch(clearPromotionRequest(request));
        }
        break;
    }
    case CONNECTION_FAILED: {
        const { error } = action;

        if (error?.name !== JitsiConnectionErrors.NOT_READY_ERROR) {
            break;
        }

        const { hosts, preferVisitor, visitors: visitorsConfig } = getState()['features/base/config'];
        const { locationURL } = getState()['features/base/connection'];

        if (!visitorsConfig?.queueService || !locationURL || !preferVisitor) {
            break;
        }

        // let's subscribe for visitor waiting queue
        const { room } = getState()['features/base/conference'];
        const conferenceJid = `${room}@${hosts?.muc}`;

        WebsocketClient.getInstance()
            .connect(`wss://${visitorsConfig?.queueService}/visitor/websocket`,
                `/secured/conference/visitor/topic.${conferenceJid}`,
                msg => {
                    if ('status' in msg && msg.status === 'live') {
                        WebsocketClient.getInstance().disconnect();
                        dispatch(setInVisitorsQueue(false));

                        let delay = 0;

                        // now let's connect to meeting
                        if ('randomDelayMs' in msg) {
                            delay = msg.randomDelayMs;
                        }

                        setTimeout(() => {
                            dispatch(joinConference());
                        }, delay);
                    }
                },
                getState()['features/base/jwt'].jwt,
                () => {
                    dispatch(setInVisitorsQueue(true));
                });

        break;
    }
    case PARTICIPANT_UPDATED: {
        const { participant } = action;
        const { local } = participant;

        if (local && isParticipantModerator(participant)) {

            const { metadata } = getState()['features/base/conference'];

            if (metadata?.visitorsLive === false) {
                // when go live is available and false, we should subscribe
                // to the service if available to listen for waiting visitors
                _subscribeQueueStats(getState(), dispatch);
            }
        }

        break;
    }
    case SET_CONFIG: {
        const result = next(action);
        const { preferVisitor } = action.config;

        if (preferVisitor !== undefined) {
            setPreferVisitor(preferVisitor);
        }

        return result;
    }
    case UPDATE_CONFERENCE_METADATA: {
        const { metadata } = action;

        if (isLocalParticipantModerator(getState)) {
            if (metadata?.[VISITORS_LIVE_ID] === false) {
                // if metadata go live changes to goLive false and local is moderator
                // we should subscribe to the service if available to listen for waiting visitors
                _subscribeQueueStats(getState(), dispatch);
            } else if (metadata?.[VISITORS_LIVE_ID]) {
                WebsocketClient.getInstance().disconnect();
            }
        }

        break;
    }
    }

    return next(action);
});

/**
 * Subscribe for moderator stats.
 *
 * @param {Function|Object} stateful - The redux store or {@code getState}
 * function.
 * @param {Dispatch} dispatch - The Redux dispatch function.
 * @returns {void}
 */
function _subscribeQueueStats(stateful: IStateful, dispatch: IStore['dispatch']) {
    const { hosts } = toState(stateful)['features/base/config'];
    const { room } = toState(stateful)['features/base/conference'];
    const conferenceJid = `${room}@${hosts?.muc}`;

    const { visitors: visitorsConfig } = toState(stateful)['features/base/config'];

    WebsocketClient.getInstance()
        .connect(`wss://${visitorsConfig?.queueService}/visitor/websocket`,
            `/secured/conference/state/topic.${conferenceJid}`,
            msg => {
                if ('visitorsWaiting' in msg) {
                    dispatch(updateVisitorsCount(msg.visitorsWaiting));
                }
            },
            toState(stateful)['features/base/jwt'].jwt);
}

/**
 * Function to handle the promotion notification.
 *
 * @param {Object} store - The Redux store.
 * @returns {void}
 */
function _handlePromotionNotification(
        { dispatch, getState }: { dispatch: IStore['dispatch']; getState: IStore['getState']; }) {
    const requests = getPromotionRequests(getState());

    if (requests.length === 0) {
        dispatch(hideNotification(VISITORS_PROMOTION_NOTIFICATION_ID));

        return;
    }

    let notificationTitle;
    let customActionNameKey;
    let customActionHandler;
    let customActionType;
    let descriptionKey;
    let icon;

    if (requests.length === 1) {
        const firstRequest = requests[0];

        descriptionKey = 'notify.participantWantsToJoin';
        notificationTitle = firstRequest.nick;
        icon = NOTIFICATION_ICON.PARTICIPANT;
        customActionNameKey = [ 'participantsPane.actions.admit', 'participantsPane.actions.reject' ];
        customActionType = [ BUTTON_TYPES.PRIMARY, BUTTON_TYPES.DESTRUCTIVE ];
        customActionHandler = [ () => batch(() => {
            dispatch(hideNotification(VISITORS_PROMOTION_NOTIFICATION_ID));
            dispatch(approveRequest(firstRequest));
        }),
        () => batch(() => {
            dispatch(hideNotification(VISITORS_PROMOTION_NOTIFICATION_ID));
            dispatch(denyRequest(firstRequest));
        }) ];
    } else {
        descriptionKey = 'notify.participantsWantToJoin';
        notificationTitle = i18n.t('notify.waitingParticipants', {
            waitingParticipants: requests.length
        });
        icon = NOTIFICATION_ICON.PARTICIPANTS;
        customActionNameKey = [ 'notify.viewVisitors' ];
        customActionType = [ BUTTON_TYPES.PRIMARY ];
        customActionHandler = [ () => batch(() => {
            dispatch(hideNotification(VISITORS_PROMOTION_NOTIFICATION_ID));
            dispatch(openParticipantsPane());
        }) ];
    }

    dispatch(showNotification({
        title: notificationTitle,
        descriptionKey,
        uid: VISITORS_PROMOTION_NOTIFICATION_ID,
        customActionNameKey,
        customActionType,
        customActionHandler,
        icon
    }, NOTIFICATION_TIMEOUT_TYPE.STICKY));
}
